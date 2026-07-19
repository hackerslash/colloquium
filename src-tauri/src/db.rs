use std::path::{Path, PathBuf};

use futures_core::future::BoxFuture;
use sqlx::error::BoxDynError;
use sqlx::migrate::{Migration as SqlxMigration, MigrationSource, MigrationType, Migrator};
use sqlx::sqlite::{SqliteConnectOptions, SqlitePoolOptions};
use sqlx::{ConnectOptions, Connection};
use tauri::Manager;
use tauri_plugin_sql::{DbInstances, DbPool, Migration, MigrationKind};

pub const DB_URL: &str = "sqlite:colloquium.db";
const DB_FILE: &str = "colloquium.db";

pub fn migrations() -> Vec<Migration> {
    const DEFS: &[(i64, &str, &str)] = &[
        (1, "identity", include_str!("../migrations/0001_identity.sql")),
        (2, "roster", include_str!("../migrations/0002_roster.sql")),
        (3, "rooms", include_str!("../migrations/0003_rooms.sql")),
        (4, "messages", include_str!("../migrations/0004_messages.sql")),
        (5, "settings", include_str!("../migrations/0005_settings.sql")),
        (6, "room_membership_v2", include_str!("../migrations/0006_room_membership_v2.sql")),
        (7, "read_state", include_str!("../migrations/0007_read_state.sql")),
        (8, "friend_requests", include_str!("../migrations/0008_friend_requests.sql")),
        (9, "message_attachments", include_str!("../migrations/0009_message_attachments.sql")),
        (10, "friend_requests_dedup", include_str!("../migrations/0010_friend_requests_dedup.sql")),
        (11, "avatars", include_str!("../migrations/0011_avatars.sql")),
        (12, "message_reactions", include_str!("../migrations/0012_message_reactions.sql")),
        (13, "message_read_receipts", include_str!("../migrations/0013_message_read_receipts.sql")),
        (14, "room_mute_state", include_str!("../migrations/0014_room_mute_state.sql")),
        (15, "messages_fts", include_str!("../migrations/0015_messages_fts.sql")),
    ];
    DEFS.iter()
        .map(|&(version, description, sql)| Migration {
            version,
            description,
            sql,
            kind: MigrationKind::Up,
        })
        .collect()
}

/// A resolved, in-memory migration set. Mirrors exactly what the tauri-plugin-sql
/// builder wrote historically — `MigrationType::ReversibleUp`, `no_tx = false`,
/// same version/description/SQL — so the SHA-384 checksums in `_sqlx_migrations`
/// still validate and only genuinely-new migrations apply.
#[derive(Debug)]
struct AppMigrations(Vec<SqlxMigration>);

impl MigrationSource<'static> for AppMigrations {
    fn resolve(self) -> BoxFuture<'static, Result<Vec<SqlxMigration>, BoxDynError>> {
        Box::pin(async move { Ok(self.0) })
    }
}

fn migration_set() -> Vec<SqlxMigration> {
    migrations()
        .into_iter()
        .map(|m| {
            SqlxMigration::new(
                m.version,
                m.description.into(),
                MigrationType::ReversibleUp,
                m.sql.into(),
                false,
            )
        })
        .collect()
}

/// SQLCipher raw-key PRAGMA value: `"x'<hex>'"`. The `x'…'` blob form skips
/// SQLCipher's per-connection PBKDF2 since the key is already full entropy.
fn key_pragma(key_hex: &str) -> String {
    format!("\"x'{key_hex}'\"")
}

/// A plaintext SQLite file starts with this exact 16-byte magic. An encrypted
/// (SQLCipher) file's header is indistinguishable from random, so this cleanly
/// tells "not yet encrypted" from "already encrypted".
fn is_plaintext(path: &Path) -> bool {
    use std::io::Read;
    let mut f = match std::fs::File::open(path) {
        Ok(f) => f,
        Err(_) => return false,
    };
    let mut buf = [0u8; 16];
    match f.read_exact(&mut buf) {
        Ok(()) => &buf == b"SQLite format 3\0",
        Err(_) => false,
    }
}

/// Whether an encrypted DB file opens and decrypts with the given key.
async fn key_opens(path: &Path, key_hex: &str) -> bool {
    let opts = SqliteConnectOptions::new()
        .filename(path)
        .pragma("key", key_pragma(key_hex));
    match opts.connect().await {
        Ok(mut conn) => {
            let ok = sqlx::query("SELECT count(*) FROM sqlite_master")
                .fetch_one(&mut conn)
                .await
                .is_ok();
            let _ = conn.close().await;
            ok
        }
        Err(_) => false,
    }
}

/// One-time encrypt of a plaintext DB via `sqlcipher_export` (PRAGMA rekey
/// cannot encrypt an existing plaintext file). The original is never mutated
/// until a verified encrypted copy exists; on any failure the tmp file is
/// removed and the original is left untouched.
async fn encrypt_plaintext(
    db: &Path,
    tmp: &Path,
    bak: &Path,
    wal: &Path,
    shm: &Path,
    key_hex: &str,
) -> Result<(), String> {
    // A stale tmp from a crashed prior attempt would poison the export.
    let _ = std::fs::remove_file(tmp);

    // Unkeyed connection reads the plaintext DB (SQLCipher with no key behaves
    // as stock SQLite) and folds in any WAL. `create_if_missing` grants this
    // connection SQLITE_OPEN_CREATE, which ATTACH inherits — without it the
    // `ATTACH … enc-tmp` below can't create the new file and fails CANTOPEN.
    let mut conn = SqliteConnectOptions::new()
        .filename(db)
        .create_if_missing(true)
        .connect()
        .await
        .map_err(|e| format!("open plaintext db: {e}"))?;

    let src_count: i64 = sqlx::query_scalar("SELECT count(*) FROM messages")
        .fetch_one(&mut conn)
        .await
        .map_err(|e| format!("count source messages: {e}"))?;

    let tmp_sql = tmp.to_string_lossy().replace('\'', "''");
    let attach = format!(
        "ATTACH DATABASE '{tmp_sql}' AS encrypted KEY {};",
        key_pragma(key_hex)
    );
    for stmt in [
        attach.as_str(),
        "SELECT sqlcipher_export('encrypted');",
        "DETACH DATABASE encrypted;",
    ] {
        if let Err(e) = sqlx::query(stmt).execute(&mut conn).await {
            let _ = conn.close().await;
            let _ = std::fs::remove_file(tmp);
            return Err(format!("sqlcipher_export failed: {e}"));
        }
    }
    let _ = conn.close().await;

    // Verify the encrypted copy opens with the key AND holds every message.
    let verified = match SqliteConnectOptions::new()
        .filename(tmp)
        .pragma("key", key_pragma(key_hex))
        .connect()
        .await
    {
        Ok(mut vc) => {
            let n: Result<i64, _> = sqlx::query_scalar("SELECT count(*) FROM messages")
                .fetch_one(&mut vc)
                .await;
            let _ = vc.close().await;
            matches!(n, Ok(c) if c == src_count)
        }
        Err(_) => false,
    };
    if !verified {
        let _ = std::fs::remove_file(tmp);
        return Err("encrypted copy failed verification".into());
    }

    // Commit: keep the plaintext as a backup until the very end of init, swap
    // the encrypted copy into place, and drop any stale WAL/SHM (pairing an old
    // WAL with the new file would corrupt it).
    let _ = std::fs::remove_file(bak);
    std::fs::rename(db, bak).map_err(|e| format!("backup plaintext db: {e}"))?;
    if let Err(e) = std::fs::rename(tmp, db) {
        // Roll back so the next boot's recovery finds the plaintext original.
        let _ = std::fs::rename(bak, db);
        return Err(format!("promote encrypted db: {e}"));
    }
    let _ = std::fs::remove_file(wal);
    let _ = std::fs::remove_file(shm);
    Ok(())
}

/// Crash-recovery + one-time encryption, run before the keyed pool opens. Every
/// interrupted state from a prior `encrypt_plaintext` converges here to either
/// the promoted encrypted DB or the restored plaintext original (to retry).
async fn ensure_encrypted(dir: &Path, key_hex: &str) -> Result<(), String> {
    let db = dir.join(DB_FILE);
    let tmp = dir.join("colloquium.db.enc-tmp");
    let bak = dir.join("colloquium.db.plain-bak");
    let wal = dir.join("colloquium.db-wal");
    let shm = dir.join("colloquium.db-shm");

    if db.exists() {
        if is_plaintext(&db) {
            // Encryption not completed. Clean any half-export and (re)encrypt.
            let _ = std::fs::remove_file(&tmp);
            return encrypt_plaintext(&db, &tmp, &bak, &wal, &shm, key_hex).await;
        }
        // Already encrypted — clear any leftovers from a prior successful swap.
        let _ = std::fs::remove_file(&tmp);
        let _ = std::fs::remove_file(&bak);
        return Ok(());
    }

    // db absent: a swap was interrupted, or this is a fresh install.
    if tmp.exists() && key_opens(&tmp, key_hex).await {
        // Export finished but the rename didn't — promote it.
        std::fs::rename(&tmp, &db).map_err(|e| format!("promote enc-tmp: {e}"))?;
        let _ = std::fs::remove_file(&wal);
        let _ = std::fs::remove_file(&shm);
        let _ = std::fs::remove_file(&bak);
        return Ok(());
    }
    if bak.exists() {
        // Restore the plaintext backup and redo the encryption.
        let _ = std::fs::remove_file(&tmp);
        std::fs::rename(&bak, &db).map_err(|e| format!("restore plain-bak: {e}"))?;
        return encrypt_plaintext(&db, &tmp, &bak, &wal, &shm, key_hex).await;
    }
    // No db, no usable tmp, no backup → fresh install. Drop any junk tmp; the
    // keyed pool creates an encrypted database from byte zero.
    let _ = std::fs::remove_file(&tmp);
    Ok(())
}

/// Builds the keyed (SQLCipher) sqlx pool, runs migrations ourselves, and
/// injects the pool into tauri-plugin-sql's `DbInstances` under `DB_URL` so the
/// plugin's execute/select commands use it — the key never enters the webview.
/// Called first in the app's setup, before any IPC can reach the plugin.
pub async fn init(app: &tauri::AppHandle) -> Result<(), String> {
    let dir = app
        .path()
        .app_config_dir()
        .map_err(|e| format!("resolve app config dir: {e}"))?;
    std::fs::create_dir_all(&dir).map_err(|e| format!("create app config dir: {e}"))?;
    let db_path: PathBuf = dir.join(DB_FILE);

    let key_hex = crate::keychain::load_or_create_db_key_hex()?;

    ensure_encrypted(&dir, &key_hex).await?;

    let opts = SqliteConnectOptions::new()
        .filename(&db_path)
        .create_if_missing(true)
        .pragma("key", key_pragma(&key_hex));
    let pool = SqlitePoolOptions::new()
        .connect_with(opts)
        .await
        .map_err(|e| format!("open keyed db pool: {e}"))?;

    // Fail fast with a clear message if the key can't unlock the file.
    sqlx::query("SELECT count(*) FROM sqlite_master")
        .fetch_one(&pool)
        .await
        .map_err(|_| "could not unlock database (key missing from OS keychain?)".to_string())?;

    let migrator = Migrator::new(AppMigrations(migration_set()))
        .await
        .map_err(|e| format!("build migrator: {e}"))?;
    migrator
        .run(&pool)
        .await
        .map_err(|e| format!("run migrations: {e}"))?;

    // Success proven — the plaintext backup (if any) may go now.
    let _ = std::fs::remove_file(dir.join("colloquium.db.plain-bak"));

    let instances = app.state::<DbInstances>();
    instances
        .0
        .write()
        .await
        .insert(DB_URL.to_string(), DbPool::Sqlite(pool));
    Ok(())
}
