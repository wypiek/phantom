// Thin typed wrappers over Tauri commands. All AI/network/storage logic lives
// in the Rust backend; the UI only calls these.
import { invoke } from '@tauri-apps/api/core';
import type {
  AppInfo,
  ClaudeStatus,
  Conversation,
  GroqModelInfo,
  InputDevice,
  KeyCheck,
  ListenMode,
  Memory,
  Message,
  ModelInfo,
  PermissionRequest,
  PiperVoiceEntry,
  Settings,
  TtsStatus,
  VoiceInfo,
  WhisperModel,
} from './types';

export const api = {
  // settings
  settingsGet: () => invoke<Settings>('settings_get'),
  settingsUpdate: (settings: Settings) => invoke<{ settings: Settings; warnings: string[] }>('settings_update', { settings }),
  settingsReset: () => invoke<Settings>('settings_reset'),

  // conversations
  conversations: (query?: string) => invoke<Conversation[]>('conversations_list', { query: query ?? null }),
  conversation: (id: string) => invoke<{ conversation: Conversation; messages: Message[]; running: boolean }>('conversation_get', { id }),
  conversationCreate: () => invoke<Conversation>('conversation_create'),
  conversationRename: (id: string, title: string) => invoke<void>('conversation_rename', { id, title }),
  conversationDelete: (id: string) => invoke<void>('conversation_delete', { id }),
  conversationClear: (id: string) => invoke<void>('conversation_clear', { id }),
  conversationsDeleteAll: () => invoke<void>('conversations_delete_all'),
  conversationExport: (id: string, format: 'markdown' | 'json', path: string) => invoke<void>('conversation_export', { id, format, path }),

  // chat
  chatSend: (text: string, conversationId: string | null, source = 'text') =>
    invoke<{ conversationId: string; userMessageId: string; assistantMessageId: string }>('chat_send', { text, conversationId, source }),
  chatCancel: (conversationId: string) => invoke<boolean>('chat_cancel', { conversationId }),
  chatCancelAll: () => invoke<void>('chat_cancel_all'),
  chatRegenerate: (conversationId: string) => invoke<{ conversationId: string; assistantMessageId: string }>('chat_regenerate', { conversationId }),
  chatSetActive: (conversationId: string | null) => invoke<void>('chat_set_active', { conversationId }),
  chatGetActive: () => invoke<string | null>('chat_get_active'),
  chatRunning: () => invoke<string[]>('chat_running'),

  // memories
  memories: () => invoke<Memory[]>('memories_list'),
  memoryAdd: (content: string) => invoke<Memory>('memory_add', { content }),
  memoryUpdate: (id: string, content: string) => invoke<void>('memory_update', { id, content }),
  memoryDelete: (id: string) => invoke<void>('memory_delete', { id }),
  memoriesClear: () => invoke<void>('memories_clear'),

  // providers
  claudeStatus: () => invoke<ClaudeStatus>('claude_status'),
  claudeWorkspace: () => invoke<{ path: string; isDefault: boolean }>('claude_workspace'),
  openrouterKeyStatus: () => invoke<{ configured: boolean; hint: string | null }>('openrouter_key_status'),
  openrouterSetKey: (key: string) => invoke<{ configured: boolean; hint: string | null }>('openrouter_set_key', { key }),
  openrouterDeleteKey: () => invoke<void>('openrouter_delete_key'),
  openrouterTest: (candidate?: string) => invoke<KeyCheck>('openrouter_test', { candidate: candidate ?? null }),
  openrouterModels: (refresh = false) => invoke<ModelInfo[]>('openrouter_models', { refresh }),
  groqKeyStatus: () => invoke<{ configured: boolean; hint: string | null }>('groq_key_status'),
  groqSetKey: (key: string) => invoke<{ configured: boolean; hint: string | null }>('groq_set_key', { key }),
  groqDeleteKey: () => invoke<void>('groq_delete_key'),
  groqTest: (candidate?: string) => invoke<{ ok: boolean; message: string }>('groq_test', { candidate: candidate ?? null }),
  groqModels: (refresh = false) => invoke<GroqModelInfo[]>('groq_models', { refresh }),

  // permissions
  permissionRespond: (id: string, allow: boolean, remember = false) => invoke<boolean>('permission_respond', { id, allow, remember }),
  permissionPending: () => invoke<PermissionRequest[]>('permission_pending'),

  // voice
  voiceDevices: () => invoke<InputDevice[]>('voice_devices'),
  voiceModels: () => invoke<WhisperModel[]>('voice_models'),
  voiceDownloadModel: (name: string) => invoke<void>('voice_download_model', { name }),
  voiceDeleteModel: (name: string) => invoke<void>('voice_delete_model', { name }),
  voiceStart: (mode?: ListenMode) => invoke<void>('voice_start', { mode: mode ?? null }),
  voiceStop: () => invoke<{ text: string; auto: boolean }>('voice_stop'),
  voiceCancel: () => invoke<void>('voice_cancel'),
  voiceSetSpeaking: (speaking: boolean) => invoke<void>('voice_set_speaking', { speaking }),
  voiceStatus: () => invoke<{ listening: boolean; mode: ListenMode | null }>('voice_status'),

  // tts
  ttsStatus: () => invoke<TtsStatus>('tts_status'),
  ttsVoices: () => invoke<VoiceInfo[]>('tts_list_voices'),
  ttsSynthesize: (text: string, rate: number, engine?: string, voice?: string) =>
    invoke<ArrayBuffer>('tts_synthesize', { text, rate, engine: engine ?? null, voice: voice ?? null }),
  ttsPiperVoices: () => invoke<PiperVoiceEntry[]>('tts_piper_voices'),
  ttsDownloadPiperVoice: (id: string) => invoke<void>('tts_download_piper_voice', { id }),

  // app
  appInfo: () => invoke<AppInfo>('app_info'),
  openWindow: (label: 'chat' | 'settings' | 'companion', section?: string) => invoke<void>('open_window', { label, section: section ?? null }),
  companionReady: () => invoke<void>('companion_ready'),
  companionToggle: () => invoke<void>('companion_toggle'),
  companionSetVisible: (visible: boolean) => invoke<void>('companion_set_visible', { visible }),
  companionSavePosition: (x: number, y: number) => invoke<void>('companion_save_position', { x, y }),
  companionSetExpanded: (expanded: boolean) => invoke<void>('companion_set_expanded', { expanded }),
  menu: (id: string) => invoke<void>('show_menu', { id }),
  quit: () => invoke<void>('quit_app'),
  restart: () => invoke<void>('app_restart'),
  revealDataDir: () => invoke<void>('reveal_data_dir'),

  // system tools
  computerPermissions: () => invoke<{ input: boolean; screen: boolean }>('computer_permissions'),
  computerOpenPermission: (which: 'screen' | 'accessibility') => invoke<void>('computer_open_permission', { which }),
  computerRepairPermission: (which: 'screen' | 'accessibility') => invoke<void>('computer_repair_permission', { which }),
};

export function errorText(e: unknown): string {
  if (typeof e === 'string') return e;
  if (e instanceof Error) return e.message;
  try {
    return JSON.stringify(e);
  } catch {
    return String(e);
  }
}
