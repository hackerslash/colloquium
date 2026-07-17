use tauri_plugin_sql::{Migration, MigrationKind};

pub const DB_URL: &str = "sqlite:haven.db";

pub fn migrations() -> Vec<Migration> {
    vec![
        Migration {
            version: 1,
            description: "identity",
            sql: include_str!("../migrations/0001_identity.sql"),
            kind: MigrationKind::Up,
        },
        Migration {
            version: 2,
            description: "roster",
            sql: include_str!("../migrations/0002_roster.sql"),
            kind: MigrationKind::Up,
        },
        Migration {
            version: 3,
            description: "rooms",
            sql: include_str!("../migrations/0003_rooms.sql"),
            kind: MigrationKind::Up,
        },
        Migration {
            version: 4,
            description: "messages",
            sql: include_str!("../migrations/0004_messages.sql"),
            kind: MigrationKind::Up,
        },
        Migration {
            version: 5,
            description: "settings",
            sql: include_str!("../migrations/0005_settings.sql"),
            kind: MigrationKind::Up,
        },
        Migration {
            version: 6,
            description: "room_membership_v2",
            sql: include_str!("../migrations/0006_room_membership_v2.sql"),
            kind: MigrationKind::Up,
        },
        Migration {
            version: 7,
            description: "read_state",
            sql: include_str!("../migrations/0007_read_state.sql"),
            kind: MigrationKind::Up,
        },
    ]
}
