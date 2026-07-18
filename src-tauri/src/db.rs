use tauri_plugin_sql::{Migration, MigrationKind};

pub const DB_URL: &str = "sqlite:haven.db";

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
