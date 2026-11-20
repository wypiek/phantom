//! Local SQLite storage for conversations, messages and long-term memories.
//!
//! Everything stays on the user's machine in `<app data dir>/phantom.db`.

use anyhow::{Context, Result};
use parking_lot::Mutex;
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use std::path::Path;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Conversation {
    pub id: String,
    pub title: String,
    pub created_at: i64,
    pub updated_at: i64,
    /// Provider used for the most recent reply.
    pub provider: Option<String>,
    /// Claude Code session id, used to resume the agent's own context.
    pub claude_session_id: Option<String>,
    pub message_count: i64,
    pub preview: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Message {
    pub id: String,
    pub conversation_id: String,
    pub role: String,
    pub content: String,
    pub created_at: i64,
    pub provider: Option<String>,
    pub model: Option<String>,
    /// "complete" | "streaming" | "error" | "cancelled"
    pub status: String,
    pub error: Option<String>,
    /// JSON array of agent activity entries (tool calls etc).
    pub activity: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Memory {
    pub id: String,
    pub content: String,
    pub created_at: i64,
    pub conversation_id: Option<String>,
}

/// A person Noli knows by voice.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Speaker {
    pub id: String,
    pub name: String,
    /// The main user of this computer.
    pub is_owner: bool,
    /// Utterances learned from.
    pub utterances: i64,
    pub created_at: i64,
    pub updated_at: i64,
    #[serde(skip)]
    pub print: String,
}

pub struct Storage {
    conn: Mutex<Connection>,
}

pub fn now_ms() -> i64 {
    chrono::Utc::now().timestamp_millis()
}

pub fn new_id() -> String {
    uuid::Uuid::new_v4().to_string()
}

const MIGRATIONS: &[&str] = &[
    // v1
    "CREATE TABLE conversations (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        provider TEXT,
        claude_session_id TEXT
    );
    CREATE TABLE messages (
        id TEXT PRIMARY KEY,
        conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
        role TEXT NOT NULL,
        content TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        provider TEXT,
        model TEXT,
        status TEXT NOT NULL DEFAULT 'complete',
        error TEXT,
        activity TEXT
    );
    CREATE INDEX idx_messages_conv ON messages(conversation_id, created_at);
    CREATE TABLE memories (
        id TEXT PRIMARY KEY,
        content TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        conversation_id TEXT
    );",
    // v2: voiceprints of people Noli has met
    "CREATE TABLE speakers (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        is_owner INTEGER NOT NULL DEFAULT 0,
        print TEXT NOT NULL,
        utterances INTEGER NOT NULL DEFAULT 1,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
    );",
];

impl Storage {
    pub fn open(path: &Path) -> Result<Self> {
        if let Some(dir) = path.parent() {
            std::fs::create_dir_all(dir)?;
        }
        let conn = Connection::open(path).with_context(|| format!("opening {}", path.display()))?;
        Self::init(conn)
    }

    #[cfg(test)]
    pub fn open_in_memory() -> Result<Self> {
        Self::init(Connection::open_in_memory()?)
    }

    fn init(conn: Connection) -> Result<Self> {
        conn.execute_batch("PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL;")?;
        let version: i64 = conn.query_row("PRAGMA user_version", [], |r| r.get(0))?;
        for (i, m) in MIGRATIONS.iter().enumerate().skip(version as usize) {
            conn.execute_batch(m)?;
            conn.execute_batch(&format!("PRAGMA user_version = {}", i + 1))?;
        }
        Ok(Self { conn: Mutex::new(conn) })
    }

    // ---- conversations ------------------------------------------------------

    pub fn create_conversation(&self, title: &str) -> Result<Conversation> {
        let c = Conversation {
            id: new_id(),
            title: title.to_string(),
            created_at: now_ms(),
            updated_at: now_ms(),
            provider: None,
            claude_session_id: None,
            message_count: 0,
            preview: None,
        };
        self.conn.lock().execute(
            "INSERT INTO conversations (id, title, created_at, updated_at) VALUES (?1, ?2, ?3, ?4)",
            params![c.id, c.title, c.created_at, c.updated_at],
        )?;
        Ok(c)
    }

    const CONV_SELECT: &'static str = "SELECT c.id, c.title, c.created_at, c.updated_at, c.provider, c.claude_session_id,
            (SELECT COUNT(*) FROM messages m WHERE m.conversation_id = c.id),
            (SELECT substr(content, 1, 140) FROM messages m WHERE m.conversation_id = c.id ORDER BY created_at DESC LIMIT 1)
         FROM conversations c";

    fn row_to_conv(r: &rusqlite::Row) -> rusqlite::Result<Conversation> {
        Ok(Conversation {
            id: r.get(0)?,
            title: r.get(1)?,
            created_at: r.get(2)?,
            updated_at: r.get(3)?,
            provider: r.get(4)?,
            claude_session_id: r.get(5)?,
            message_count: r.get(6)?,
            preview: r.get(7)?,
        })
    }

    pub fn get_conversation(&self, id: &str) -> Result<Option<Conversation>> {
        let conn = self.conn.lock();
        let sql = format!("{} WHERE c.id = ?1", Self::CONV_SELECT);
        Ok(conn.query_row(&sql, params![id], Self::row_to_conv).optional()?)
    }

    /// Lists conversations, newest first. `query` filters by title or message text.
    pub fn list_conversations(&self, query: Option<&str>) -> Result<Vec<Conversation>> {
        let conn = self.conn.lock();
        let q = query.map(str::trim).filter(|q| !q.is_empty());
        let mut out = vec![];
        match q {
            Some(q) => {
                let like = format!("%{}%", q.replace('\\', "\\\\").replace('%', "\\%").replace('_', "\\_"));
                let sql = format!(
                    "{} WHERE c.title LIKE ?1 ESCAPE '\\' OR EXISTS (SELECT 1 FROM messages m WHERE m.conversation_id = c.id AND m.content LIKE ?1 ESCAPE '\\') ORDER BY c.updated_at DESC",
                    Self::CONV_SELECT
                );
                let mut st = conn.prepare(&sql)?;
                for r in st.query_map(params![like], Self::row_to_conv)? {
                    out.push(r?);
                }
            }
            None => {
                let sql = format!("{} ORDER BY c.updated_at DESC", Self::CONV_SELECT);
                let mut st = conn.prepare(&sql)?;
                for r in st.query_map([], Self::row_to_conv)? {
                    out.push(r?);
                }
            }
        }
        Ok(out)
    }

    pub fn rename_conversation(&self, id: &str, title: &str) -> Result<()> {
        self.conn.lock().execute("UPDATE conversations SET title = ?2 WHERE id = ?1", params![id, title])?;
        Ok(())
    }

    pub fn touch_conversation(&self, id: &str, provider: Option<&str>) -> Result<()> {
        self.conn.lock().execute(
            "UPDATE conversations SET updated_at = ?2, provider = COALESCE(?3, provider) WHERE id = ?1",
            params![id, now_ms(), provider],
        )?;
        Ok(())
    }

    pub fn set_claude_session(&self, id: &str, session: Option<&str>) -> Result<()> {
        self.conn.lock().execute("UPDATE conversations SET claude_session_id = ?2 WHERE id = ?1", params![id, session])?;
        Ok(())
    }

    pub fn delete_conversation(&self, id: &str) -> Result<()> {
        self.conn.lock().execute("DELETE FROM conversations WHERE id = ?1", params![id])?;
        Ok(())
    }

    /// Removes all messages but keeps the conversation itself.
    pub fn clear_conversation(&self, id: &str) -> Result<()> {
        let conn = self.conn.lock();
        conn.execute("DELETE FROM messages WHERE conversation_id = ?1", params![id])?;
        conn.execute("UPDATE conversations SET claude_session_id = NULL, updated_at = ?2 WHERE id = ?1", params![id, now_ms()])?;
        Ok(())
    }

    pub fn delete_all_conversations(&self) -> Result<()> {
        self.conn.lock().execute_batch("DELETE FROM messages; DELETE FROM conversations;")?;
        Ok(())
    }

    // ---- messages -----------------------------------------------------------

    pub fn add_message(&self, m: &Message) -> Result<()> {
        self.conn.lock().execute(
            "INSERT INTO messages (id, conversation_id, role, content, created_at, provider, model, status, error, activity)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)",
            params![m.id, m.conversation_id, m.role, m.content, m.created_at, m.provider, m.model, m.status, m.error, m.activity],
        )?;
        Ok(())
    }

    pub fn update_message(&self, id: &str, content: &str, status: &str, error: Option<&str>, activity: Option<&str>) -> Result<()> {
        self.conn.lock().execute(
            "UPDATE messages SET content = ?2, status = ?3, error = ?4, activity = COALESCE(?5, activity) WHERE id = ?1",
            params![id, content, status, error, activity],
        )?;
        Ok(())
    }

    pub fn set_message_model(&self, id: &str, model: &str) -> Result<()> {
        self.conn.lock().execute("UPDATE messages SET model = ?2 WHERE id = ?1", params![id, model])?;
        Ok(())
    }

    pub fn messages(&self, conversation_id: &str) -> Result<Vec<Message>> {
        let conn = self.conn.lock();
        let mut st = conn.prepare(
            "SELECT id, conversation_id, role, content, created_at, provider, model, status, error, activity
             FROM messages WHERE conversation_id = ?1 ORDER BY created_at ASC, rowid ASC",
        )?;
        let rows = st.query_map(params![conversation_id], |r| {
            Ok(Message {
                id: r.get(0)?,
                conversation_id: r.get(1)?,
                role: r.get(2)?,
                content: r.get(3)?,
                created_at: r.get(4)?,
                provider: r.get(5)?,
                model: r.get(6)?,
                status: r.get(7)?,
                error: r.get(8)?,
                activity: r.get(9)?,
            })
        })?;
        Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
    }

    pub fn delete_message(&self, id: &str) -> Result<()> {
        self.conn.lock().execute("DELETE FROM messages WHERE id = ?1", params![id])?;
        Ok(())
    }

    /// Marks any message left "streaming" by a crash as interrupted.
    pub fn recover_interrupted(&self) -> Result<usize> {
        Ok(self.conn.lock().execute(
            "UPDATE messages SET status = 'error', error = 'Interrupted — PHANTOM was closed while answering.' WHERE status = 'streaming'",
            [],
        )?)
    }

    // ---- memories -----------------------------------------------------------

    pub fn add_memory(&self, content: &str, conversation_id: Option<&str>) -> Result<Memory> {
        let content = content.trim();
        // de-duplicate exact repeats
        let conn = self.conn.lock();
        if let Some(existing) = conn
            .query_row("SELECT id, content, created_at, conversation_id FROM memories WHERE lower(content) = lower(?1)", params![content], |r| {
                Ok(Memory { id: r.get(0)?, content: r.get(1)?, created_at: r.get(2)?, conversation_id: r.get(3)? })
            })
            .optional()?
        {
            return Ok(existing);
        }
        let m = Memory { id: new_id(), content: content.into(), created_at: now_ms(), conversation_id: conversation_id.map(Into::into) };
        conn.execute(
            "INSERT INTO memories (id, content, created_at, conversation_id) VALUES (?1, ?2, ?3, ?4)",
            params![m.id, m.content, m.created_at, m.conversation_id],
        )?;
        Ok(m)
    }

    pub fn memories(&self) -> Result<Vec<Memory>> {
        let conn = self.conn.lock();
        let mut st = conn.prepare("SELECT id, content, created_at, conversation_id FROM memories ORDER BY created_at DESC")?;
        let rows = st.query_map([], |r| Ok(Memory { id: r.get(0)?, content: r.get(1)?, created_at: r.get(2)?, conversation_id: r.get(3)? }))?;
        Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
    }

    pub fn update_memory(&self, id: &str, content: &str) -> Result<()> {
        self.conn.lock().execute("UPDATE memories SET content = ?2 WHERE id = ?1", params![id, content.trim()])?;
        Ok(())
    }

    pub fn delete_memory(&self, id: &str) -> Result<()> {
        self.conn.lock().execute("DELETE FROM memories WHERE id = ?1", params![id])?;
        Ok(())
    }

    pub fn delete_all_memories(&self) -> Result<()> {
        self.conn.lock().execute("DELETE FROM memories", [])?;
        Ok(())
    }

    // ---- speakers -----------------------------------------------------------

    const SPEAKER_SELECT: &'static str = "SELECT id, name, is_owner, utterances, created_at, updated_at, print FROM speakers";

    fn speaker_row(r: &rusqlite::Row) -> rusqlite::Result<Speaker> {
        Ok(Speaker {
            id: r.get(0)?,
            name: r.get(1)?,
            is_owner: r.get::<_, i64>(2)? != 0,
            utterances: r.get(3)?,
            created_at: r.get(4)?,
            updated_at: r.get(5)?,
            print: r.get(6)?,
        })
    }

    /// Owner first, then most recently heard.
    pub fn speakers(&self) -> Result<Vec<Speaker>> {
        let conn = self.conn.lock();
        let mut st = conn.prepare(&format!("{} ORDER BY is_owner DESC, updated_at DESC", Self::SPEAKER_SELECT))?;
        let rows = st.query_map([], Self::speaker_row)?;
        Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
    }

    pub fn speaker_by_name(&self, name: &str) -> Result<Option<Speaker>> {
        let conn = self.conn.lock();
        Ok(conn.query_row(&format!("{} WHERE lower(name) = lower(?1)", Self::SPEAKER_SELECT), params![name.trim()], Self::speaker_row).optional()?)
    }

    pub fn add_speaker(&self, name: &str, is_owner: bool, print: &str) -> Result<Speaker> {
        let now = now_ms();
        let sp = Speaker { id: new_id(), name: name.trim().to_string(), is_owner, utterances: 1, created_at: now, updated_at: now, print: print.to_string() };
        let mut conn = self.conn.lock();
        let tx = conn.transaction()?;
        if is_owner {
            tx.execute("UPDATE speakers SET is_owner = 0", [])?;
        }
        tx.execute(
            "INSERT INTO speakers (id, name, is_owner, print, utterances, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, 1, ?5, ?5)",
            params![sp.id, sp.name, is_owner as i64, sp.print, now],
        )?;
        tx.commit()?;
        Ok(sp)
    }

    /// Stores an updated voiceprint after learning from another utterance.
    pub fn update_speaker_print(&self, id: &str, print: &str, learned: bool) -> Result<()> {
        self.conn.lock().execute(
            "UPDATE speakers SET print = ?2, utterances = utterances + ?3, updated_at = ?4 WHERE id = ?1",
            params![id, print, learned as i64, now_ms()],
        )?;
        Ok(())
    }

    pub fn rename_speaker(&self, id: &str, name: &str) -> Result<()> {
        self.conn.lock().execute("UPDATE speakers SET name = ?2 WHERE id = ?1", params![id, name.trim()])?;
        Ok(())
    }

    pub fn set_owner(&self, id: &str) -> Result<()> {
        let mut conn = self.conn.lock();
        let tx = conn.transaction()?;
        tx.execute("UPDATE speakers SET is_owner = (id = ?1)", params![id])?;
        tx.commit()?;
        Ok(())
    }

    pub fn delete_speaker(&self, id: &str) -> Result<()> {
        self.conn.lock().execute("DELETE FROM speakers WHERE id = ?1", params![id])?;
        Ok(())
    }

    pub fn delete_all_speakers(&self) -> Result<()> {
        self.conn.lock().execute("DELETE FROM speakers", [])?;
        Ok(())
    }

    // ---- retention ----------------------------------------------------------

    /// Applies retention windows (0 = keep forever). Returns (conversations, memories) removed.
    pub fn apply_retention(&self, history_days: u32, memory_days: u32) -> Result<(usize, usize)> {
        let conn = self.conn.lock();
        let day = 86_400_000i64;
        let mut removed = (0, 0);
        if history_days > 0 {
            let cutoff = now_ms() - history_days as i64 * day;
            removed.0 = conn.execute("DELETE FROM conversations WHERE updated_at < ?1", params![cutoff])?;
        }
        if memory_days > 0 {
            let cutoff = now_ms() - memory_days as i64 * day;
            removed.1 = conn.execute("DELETE FROM memories WHERE created_at < ?1", params![cutoff])?;
        }
        Ok(removed)
    }

    // ---- export -------------------------------------------------------------

    pub fn export_markdown(&self, id: &str) -> Result<String> {
        let conv = self.get_conversation(id)?.context("conversation not found")?;
        let mut out = format!("# {}\n\n", conv.title);
        let created = chrono::DateTime::from_timestamp_millis(conv.created_at).map(|d| d.to_rfc3339()).unwrap_or_default();
        out.push_str(&format!("_Exported from PHANTOM · started {created}_\n\n"));
        for m in self.messages(id)? {
            let who = if m.role == "user" { "You" } else { "PHANTOM" };
            let at = chrono::DateTime::from_timestamp_millis(m.created_at).map(|d| d.format("%Y-%m-%d %H:%M").to_string()).unwrap_or_default();
            out.push_str(&format!("### {who} · {at}\n\n{}\n\n", m.content.trim()));
        }
        Ok(out)
    }

    pub fn export_json(&self, id: &str) -> Result<String> {
        let conv = self.get_conversation(id)?.context("conversation not found")?;
        let msgs = self.messages(id)?;
        Ok(serde_json::to_string_pretty(&serde_json::json!({ "conversation": conv, "messages": msgs }))?)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn msg(conv: &str, role: &str, content: &str) -> Message {
        Message {
            id: new_id(),
            conversation_id: conv.into(),
            role: role.into(),
            content: content.into(),
            created_at: now_ms(),
            provider: None,
            model: None,
            status: "complete".into(),
            error: None,
            activity: None,
        }
    }

    #[test]
    fn conversation_lifecycle() {
        let s = Storage::open_in_memory().unwrap();
        let c = s.create_conversation("First contact").unwrap();
        s.add_message(&msg(&c.id, "user", "hello creature")).unwrap();
        s.add_message(&msg(&c.id, "assistant", "I have been waiting.")).unwrap();
        let list = s.list_conversations(None).unwrap();
        assert_eq!(list.len(), 1);
        assert_eq!(list[0].message_count, 2);
        assert_eq!(s.messages(&c.id).unwrap()[0].role, "user");

        // search by message text and by title
        assert_eq!(s.list_conversations(Some("waiting")).unwrap().len(), 1);
        assert_eq!(s.list_conversations(Some("contact")).unwrap().len(), 1);
        assert_eq!(s.list_conversations(Some("nothing-here")).unwrap().len(), 0);
        // LIKE wildcards are escaped
        assert_eq!(s.list_conversations(Some("%")).unwrap().len(), 0);

        s.clear_conversation(&c.id).unwrap();
        assert!(s.messages(&c.id).unwrap().is_empty());
        s.delete_conversation(&c.id).unwrap();
        assert!(s.get_conversation(&c.id).unwrap().is_none());
    }

    #[test]
    fn cascade_delete_and_export() {
        let s = Storage::open_in_memory().unwrap();
        let c = s.create_conversation("Export me").unwrap();
        s.add_message(&msg(&c.id, "user", "ping")).unwrap();
        s.add_message(&msg(&c.id, "assistant", "pong")).unwrap();
        let md = s.export_markdown(&c.id).unwrap();
        assert!(md.contains("# Export me") && md.contains("pong"));
        let js: serde_json::Value = serde_json::from_str(&s.export_json(&c.id).unwrap()).unwrap();
        assert_eq!(js["messages"].as_array().unwrap().len(), 2);
        s.delete_conversation(&c.id).unwrap();
        let n: i64 = s.conn.lock().query_row("SELECT COUNT(*) FROM messages", [], |r| r.get(0)).unwrap();
        assert_eq!(n, 0);
    }

    #[test]
    fn speakers_have_one_owner() {
        let s = Storage::open_in_memory().unwrap();
        let a = s.add_speaker("Ada", true, "{}").unwrap();
        let b = s.add_speaker("Bob", true, "{}").unwrap();
        let list = s.speakers().unwrap();
        assert_eq!(list.len(), 2);
        assert_eq!(list.iter().filter(|x| x.is_owner).count(), 1);
        assert!(list[0].is_owner && list[0].id == b.id);
        s.set_owner(&a.id).unwrap();
        assert!(s.speakers().unwrap().iter().find(|x| x.id == a.id).unwrap().is_owner);
        assert_eq!(s.speaker_by_name("ada").unwrap().unwrap().id, a.id);
        s.update_speaker_print(&a.id, "{\"x\":1}", true).unwrap();
        assert_eq!(s.speaker_by_name("ADA").unwrap().unwrap().utterances, 2);
        s.delete_speaker(&a.id).unwrap();
        assert_eq!(s.speakers().unwrap().len(), 1);
    }

    #[test]
    fn memories_dedupe_and_delete() {
        let s = Storage::open_in_memory().unwrap();
        let a = s.add_memory("User likes synthwave", None).unwrap();
        let b = s.add_memory("user likes SYNTHWAVE", None).unwrap();
        assert_eq!(a.id, b.id);
        assert_eq!(s.memories().unwrap().len(), 1);
        s.delete_memory(&a.id).unwrap();
        assert!(s.memories().unwrap().is_empty());
    }

    #[test]
    fn interrupted_recovery() {
        let s = Storage::open_in_memory().unwrap();
        let c = s.create_conversation("x").unwrap();
        let mut m = msg(&c.id, "assistant", "half an answ");
        m.status = "streaming".into();
        s.add_message(&m).unwrap();
        assert_eq!(s.recover_interrupted().unwrap(), 1);
        assert_eq!(s.messages(&c.id).unwrap()[0].status, "error");
    }
}
