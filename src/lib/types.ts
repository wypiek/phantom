// Mirrors of the Rust types exchanged over IPC (see src-tauri/src/*.rs).

export type ProviderId = 'claude-code' | 'openrouter' | 'groq';
export type ClaudePermission = 'chat-only' | 'read-only' | 'ask' | 'accept-edits';
export type ListenMode = 'push-to-talk' | 'continuous';

export interface FxParams {
  /** playback pitch multiplier (0.5–1.5); <1 = deeper */
  pitch: number;
  /** speaking speed multiplier, independent of pitch */
  speed: number;
  reverb: number; // 0–1 wet
  echo: number; // 0–1 feedback/wet
  echoTime: number; // seconds
  distortion: number; // 0–1 drive
  lowpass: number; // Hz cutoff
  bitcrush: number; // 0–1 amount
  staticNoise: number; // 0–1 background static
  ringMod: number; // 0–1 robotic ring modulation
  pauses: number; // 0–1 chance of unnatural pauses between phrases
  volume: number; // 0–1.5
}

export interface Settings {
  general: {
    onboardingComplete: boolean;
    launchAtStartup: boolean;
    startMinimized: boolean;
    characterSize: number;
    characterOpacity: number;
    alwaysOnTop: boolean;
    clickThrough: boolean;
    characterVisible: boolean;
    position: { x: number; y: number } | null;
    shortcuts: { toggleCharacter: string; pushToTalk: string; openChat: string };
  };
  provider: {
    active: ProviderId;
    openrouter: { model: string; temperature: number; maxTokens: number; baseUrl: string };
    groq: { model: string; temperature: number; maxTokens: number; baseUrl: string };
    claudeCode: {
      binaryPath: string;
      workingDirectory: string;
      permission: ClaudePermission;
      model: string;
      allowedTools: string[];
      lightweight: boolean;
    };
  };
  personality: { systemPrompt: string; ambientRemarks: boolean };
  voice: {
    enabled: boolean;
    sttEngine: string;
    whisperModel: string;
    language: string;
    inputDevice: string;
    inputGain: number;
    mode: ListenMode;
    confirmBeforeSend: boolean;
    vadSensitivity: number;
    interruptOnSpeech: boolean;
    /** beam-search decoding for final transcripts */
    accurateTranscription: boolean;
    /** tell people apart by voice, ask unknown speakers who they are */
    speakerRecognition: boolean;
    /** 0..1, higher = more readily treats a voice as someone new */
    speakerStrictness: number;
  };
  tts: {
    enabled: boolean;
    engine: 'system' | 'piper';
    systemVoice: string;
    piperPath: string;
    piperModel: string;
    preset: string;
    fx: FxParams | null;
    customPresets: Record<string, FxParams>;
  };
  appearance: {
    idleAnimations: boolean;
    wander: boolean;
    reducedMotion: boolean;
    interfaceScale: number;
    uiSounds: boolean;
    theme: 'crypt' | 'void';
    showSpeechBubble: boolean;
  };
  privacy: {
    saveHistory: boolean;
    historyRetentionDays: number;
    memoryEnabled: boolean;
    memoryRetentionDays: number;
  };
  computer: {
    mode: 'off' | 'ask' | 'trusted';
    sendScreenshots: boolean;
    maxSteps: number;
  };
  profile: {
    /** the main user's name, learned when Noli introduced itself */
    userName: string;
    /** Noli has introduced itself */
    introduced: boolean;
  };
}

/** Who said a voice transcript (from local voiceprints). */
export interface SpeakerInfo {
  /** known/likely = recognised; unknown = someone new; new = nobody enrolled yet; unclear = too little speech */
  status: 'known' | 'likely' | 'unknown' | 'new' | 'unclear';
  id: string | null;
  name: string | null;
  isOwner: boolean;
  /** pass to speakerEnroll to learn this voice */
  token: string | null;
  distance: number | null;
}

export interface Transcript {
  text: string;
  auto: boolean;
  speaker: SpeakerInfo | null;
}

export interface Speaker {
  id: string;
  name: string;
  isOwner: boolean;
  utterances: number;
  createdAt: number;
  updatedAt: number;
}

export interface Conversation {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  provider: string | null;
  claudeSessionId: string | null;
  messageCount: number;
  preview: string | null;
}

export interface Activity {
  id: string;
  kind: 'tool' | 'status' | 'permission';
  label: string;
  detail: string | null;
  state: 'running' | 'done' | 'error' | 'denied' | 'info';
}

export interface Message {
  id: string;
  conversationId: string;
  role: 'user' | 'assistant';
  content: string;
  createdAt: number;
  provider: string | null;
  model: string | null;
  status: 'complete' | 'streaming' | 'error' | 'cancelled';
  error: string | null;
  activity: string | null;
}

export interface ChatEvent {
  conversationId: string;
  messageId: string;
  kind: 'start' | 'delta' | 'activity' | 'done' | 'error' | 'cancelled';
  delta: string | null;
  content: string | null;
  activity: Activity | null;
  error: string | null;
  source: string | null;
  provider: string | null;
  model: string | null;
}

export interface Memory {
  id: string;
  content: string;
  createdAt: number;
  conversationId: string | null;
}

export interface PermissionRequest {
  id: string;
  conversationId: string;
  workspace: string;
  toolName: string;
  summary: string | null;
  input: unknown;
}

export interface ClaudeStatus {
  installed: boolean;
  path: string | null;
  version: string | null;
  loggedIn: boolean;
  authMethod: string | null;
  subscription: string | null;
  error: string | null;
}

export interface ModelInfo {
  id: string;
  name: string;
  contextLength: number | null;
  promptPrice: number | null;
  completionPrice: number | null;
  description: string | null;
  /** accepts images (can look at screenshots) */
  vision?: boolean;
}

export interface GroqModelInfo {
  id: string;
  ownedBy: string | null;
  contextWindow: number | null;
  active: boolean;
}

export interface KeyCheck {
  ok: boolean;
  label: string | null;
  usage: number | null;
  limit: number | null;
  isFreeTier: boolean | null;
  message: string;
}

export interface InputDevice {
  name: string;
  isDefault: boolean;
}

export interface WhisperModel {
  name: string;
  sizeMb: number;
  description: string;
  downloaded: boolean;
  downloading: boolean;
}

export interface VoiceInfo {
  id: string;
  name: string;
  language: string;
}

export interface TtsStatus {
  systemAvailable: boolean;
  systemEngine: string;
  piperPath: string | null;
  piperModels: string[];
  piperModelsDir: string;
}

export interface PiperVoiceEntry {
  id: string;
  description: string;
  sizeMb: number;
  downloaded: boolean;
}

export interface AppInfo {
  version: string;
  platform: string;
  dataDir: string;
  defaultWorkspace: string;
  permissionBridge: boolean;
}

export interface ScreenInfo {
  frontmostApp: string | null;
  windowTitle: string | null;
  screenshotPath: string | null;
  screenshotBase64: string | null;
}

export interface CommandOutput {
  success: boolean;
  stdout: string;
  stderr: string;
  exitCode: number | null;
}
