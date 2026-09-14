//! SQLite migrations for `tauri-plugin-sql` (Task 6).
//!
//! Registered in `lib.rs` (Task 11) via:
//! `tauri_plugin_sql::Builder::default().add_migrations("sqlite:meetingai.db", db::migrations())`
//!
//! The database URL `sqlite:meetingai.db` must match the one used by the TS
//! data layer in `src/lib/db.ts`.

use tauri_plugin_sql::{Migration, MigrationKind};

/// All schema migrations, in order. SQL is exactly as specified in the
/// implementation plan (Task 6).
pub fn migrations() -> Vec<Migration> {
    vec![Migration {
        version: 1,
        description: "create_meetings_and_transcript_segments",
        sql: "\
CREATE TABLE meetings (id TEXT PRIMARY KEY, title TEXT NOT NULL, started_at INTEGER NOT NULL, ended_at INTEGER, calendar_event_id TEXT, summary_json TEXT, user_notes TEXT DEFAULT '');
CREATE TABLE transcript_segments (id TEXT PRIMARY KEY, meeting_id TEXT NOT NULL REFERENCES meetings(id), speaker TEXT NOT NULL, text TEXT NOT NULL, translated_text TEXT, lang TEXT, t_start INTEGER NOT NULL, t_end INTEGER, final INTEGER NOT NULL DEFAULT 1);
CREATE INDEX idx_segments_meeting ON transcript_segments(meeting_id, t_start);",
        kind: MigrationKind::Up,
    }]
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn migration_v1_matches_plan() {
        let m = migrations();
        assert_eq!(m.len(), 1);
        assert_eq!(m[0].version, 1);
        assert!(m[0].sql.contains("CREATE TABLE meetings (id TEXT PRIMARY KEY"));
        assert!(m[0]
            .sql
            .contains("CREATE TABLE transcript_segments (id TEXT PRIMARY KEY"));
        assert!(m[0]
            .sql
            .contains("CREATE INDEX idx_segments_meeting ON transcript_segments(meeting_id, t_start);"));
    }
}
