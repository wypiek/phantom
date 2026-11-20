import { listen } from '@tauri-apps/api/event';
import { Menu, MenuItem, PredefinedMenuItem, CheckMenuItem } from '@tauri-apps/api/menu';
import { currentMonitor, getCurrentWindow, LogicalPosition } from '@tauri-apps/api/window';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { UiSprite } from '../components/ui';
import { hideMemoryTags } from '../storage/memories';
import type { Reply } from './brain';
import type { FixPage } from './reactions';
import type { PermissionRequest } from '../lib/types';
import { api } from '../lib/ipc';
import { settingsStore, useSettings } from '../lib/useSettings';
import { ttsPlayer } from '../audio/ttsPlayer';
import { starChime } from '../lib/sounds';
import { loadAtlas, type Atlas } from './atlas';
import { Brain } from './brain';
import { buildClips } from './clips';
import { CompanionMachine } from './machine';
import { SpriteRenderer } from './renderer';

const SLEEP_AFTER_MS = 7 * 60_000;

export function Companion() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const brainRef = useRef<Brain | null>(null);
  const [atlas, setAtlas] = useState<Atlas | null>(null);
  const [, force] = useState(0);
  const { settings } = useSettings();

  useEffect(() => {
    document.documentElement.classList.add('companion-root');
    loadAtlas().then(setAtlas).catch((e) => console.error(e));
  }, []);

  // ---- engine: machine + renderer + brain + render loop ---------------------
  useEffect(() => {
    if (!atlas || !canvasRef.current) return;
    const s = settingsStore.current;
    const machine = new CompanionMachine(buildClips(atlas.manifest), {
      idleVariety: !!s?.appearance.idleAnimations && !s?.appearance.reducedMotion,
      sleepAfterMs: SLEEP_AFTER_MS,
    }, performance.now());
    const renderer = new SpriteRenderer(canvasRef.current, atlas);
    // every launch (and every time it's summoned back) Noli arrives on a falling star
    const arrive = () => {
      machine.spawn(performance.now(), !!settingsStore.current?.appearance.reducedMotion);
      starChime();
    };
    machine.spawn(performance.now(), !!s?.appearance.reducedMotion);
    let spawnedAt = performance.now();
    const unShown = listen('companion://shown', () => {
      // the launch spawn already started a moment ago: don't restart it
      if (machine.spawning && performance.now() - spawnedAt < 600) return starChime();
      spawnedAt = performance.now();
      arrive();
    });
    const brain = new Brain(machine);
    brainRef.current = brain;
    const unUi = brain.onUi(() => force((n) => n + 1));
    void brain.start();

    let mouth = 0;
    let timer: ReturnType<typeof setTimeout>;
    let wander: { until: number; flip: boolean } | null = null;
    let nextWander = performance.now() + 15_000 + Math.random() * 30_000;
    let alive = true;

    const doWander = async () => {
      const cur = settingsStore.current;
      if (!cur?.appearance.wander || cur.appearance.reducedMotion || machine.mood !== 'idle' || machine.base !== 'idle' || !brain.idle) return;
      const win = getCurrentWindow();
      const mon = await currentMonitor();
      if (!mon) return;
      const scale = await win.scaleFactor();
      const pos = (await win.outerPosition()).toLogical(scale);
      const size = (await win.outerSize()).toLogical(scale);
      const monPos = mon.position.toLogical(mon.scaleFactor);
      const monSize = mon.size.toLogical(mon.scaleFactor);
      // stay on screen; near an edge he tends to head back toward the middle
      const minX = monPos.x + 8;
      const maxX = monPos.x + monSize.width - size.width - 8;
      const towardMiddle = pos.x + size.width / 2 < monPos.x + monSize.width / 2 ? 1 : -1;
      const dir = Math.random() < 0.65 ? towardMiddle : -towardMiddle;
      const target = Math.max(minX, Math.min(maxX, pos.x + dir * (80 + Math.random() * 260)));
      const dist = target - pos.x;
      if (Math.abs(dist) < 30) return;
      const startX = pos.x;
      const speed = 42; // px/s
      const dur = (Math.abs(dist) / speed) * 1000;
      const t0 = performance.now();
      wander = { until: t0 + dur, flip: dist < 0 };
      machine.loopClip('walk', t0);
      const step = async () => {
        if (!alive || !wander) return;
        const k = Math.min(1, (performance.now() - t0) / dur);
        // stop the moment something happens (user grabs him, chat opens, a reply starts)
        const interrupted = machine.mood !== 'idle' || !brain.idle;
        if (!interrupted) await win.setPosition(new LogicalPosition(Math.round(startX + dist * k), pos.y));
        if (k < 1 && !interrupted) setTimeout(step, 50);
        else {
          wander = null;
          if (machine.mood === 'idle') {
            machine.backToBase(performance.now());
            if (!interrupted && Math.random() < 0.4) machine.oneShot('look_around', performance.now());
          }
        }
      };
      void step();
    };

    const loop = () => {
      if (!alive) return;
      const now = performance.now();
      const fs = machine.tick(now);
      const target = fs.effects.includes('mouth') ? (ttsPlayer.speaking ? ttsPlayer.level() : 0.25 + 0.35 * Math.abs(Math.sin(now * 0.013))) : 0;
      mouth = mouth * 0.45 + target * 0.55;
      const cur = settingsStore.current;
      renderer.draw({ state: fs, t: now, mouth, mic: brain.micLevel, flip: !!wander?.flip, reducedMotion: !!cur?.appearance.reducedMotion });
      // expire bubble
      if (brain.bubble && brain.bubble.until && now > brain.bubble.until) brain.clearBubble();
      if (now > nextWander) {
        nextWander = now + 20_000 + Math.random() * 55_000;
        void doWander();
      }
      const fast = machine.isAnimatedFast() || !!wander;
      const interval = document.hidden ? 1000 : fast ? 33 : fs.clip === 'sleeping' ? 200 : 80;
      timer = setTimeout(loop, interval);
    };
    loop();
    void api.companionReady();

    return () => {
      alive = false;
      clearTimeout(timer);
      void unShown.then((f) => f());
      unUi();
      brain.dispose();
    };
  }, [atlas]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && brainRef.current?.chatOpen) brainRef.current.setChatOpen(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  // ---- persist position after the user drags the window ---------------------
  useEffect(() => {
    const win = getCurrentWindow();
    let t: ReturnType<typeof setTimeout>;
    const un = win.onMoved(({ payload }) => {
      clearTimeout(t);
      t = setTimeout(async () => {
        const scale = await win.scaleFactor();
        const p = payload.toLogical(scale);
        void api.companionSavePosition(p.x, p.y);
      }, 600);
    });
    return () => {
      clearTimeout(t);
      void un.then((f) => f());
    };
  }, []);

  // ---- pointer interaction ----------------------------------------------------
  const down = useRef<{ x: number; y: number; dragging: boolean } | null>(null);
  const hitsSprite = (e: React.MouseEvent) => {
    const c = canvasRef.current;
    if (!c) return false;
    const r = c.getBoundingClientRect();
    const x = Math.floor(((e.clientX - r.left) / r.width) * c.width);
    const y = Math.floor(((e.clientY - r.top) / r.height) * c.height);
    if (x < 0 || y < 0 || x >= c.width || y >= c.height) return false;
    const ctx = c.getContext('2d');
    // generous hit area: any opaque pixel nearby
    const d = ctx?.getImageData(Math.max(0, x - 4), Math.max(0, y - 4), 9, 9).data;
    if (!d) return false;
    for (let i = 3; i < d.length; i += 4) if (d[i] > 40) return true;
    return false;
  };

  const onMouseDown = (e: React.MouseEvent) => {
    if (e.button !== 0) return;
    down.current = { x: e.screenX, y: e.screenY, dragging: false };
    if (brainRef.current) brainRef.current.holding = true;
    void ttsPlayer.unlock();
  };
  const onMouseMove = (e: React.MouseEvent) => {
    const d = down.current;
    if (!d || d.dragging || e.buttons !== 1) return;
    if (Math.hypot(e.screenX - d.x, e.screenY - d.y) > 3) {
      d.dragging = true;
      void getCurrentWindow().startDragging();
    }
  };
  const onMouseUp = (e: React.MouseEvent) => {
    const d = down.current;
    down.current = null;
    if (brainRef.current) brainRef.current.holding = false;
    if (!d || d.dragging) return;
    if (e.detail === 1 && hitsSprite(e)) brainRef.current?.command('poke');
  };
  const onDoubleClick = (e: React.MouseEvent) => {
    if (hitsSprite(e)) brainRef.current?.setChatOpen(!brainRef.current.chatOpen);
  };
  const onContextMenu = async (e: React.MouseEvent) => {
    e.preventDefault();
    const s = settingsStore.current;
    const brain = brainRef.current;
    const listening = !!brain?.voice.listening;
    const items = await Promise.all([
      MenuItem.new({ text: listening ? 'Stop listening' : 'Talk to Noli', action: () => void brain?.voice.toggle() }),
      MenuItem.new({ text: brain?.chatOpen ? 'Close chatbox' : 'Chatbox', action: () => brain?.setChatOpen(!brain.chatOpen) }),
      MenuItem.new({ text: 'New conversation', action: () => void api.conversationCreate().then(() => brain?.setChatOpen(true)) }),
      MenuItem.new({ text: 'Conversation history…', action: () => void api.openWindow('settings', 'history') }),
      MenuItem.new({ text: 'Stop speaking', enabled: ttsPlayer.speaking, action: () => brain?.interrupt() }),
      PredefinedMenuItem.new({ item: 'Separator' }),
      CheckMenuItem.new({ text: 'Click-through', checked: !!s?.general.clickThrough, action: () => void api.menu('click_through') }),
      CheckMenuItem.new({ text: 'Always on top', checked: !!s?.general.alwaysOnTop, action: () => void api.menu('on_top') }),
      MenuItem.new({ text: 'Vanish for a moment', action: () => brain?.command('vanish') }),
      MenuItem.new({ text: 'Hide', action: () => void api.companionSetVisible(false) }),
      PredefinedMenuItem.new({ item: 'Separator' }),
      MenuItem.new({ text: 'Settings…', action: () => void api.openWindow('settings') }),
      MenuItem.new({ text: 'Quit Noli', action: () => void api.quit() }),
    ]);
    const menu = await Menu.new({ items });
    await menu.popup();
  };

  const size = settings?.general.characterSize ?? 190;
  const opacity = settings?.general.characterOpacity ?? 1;
  const aspect = atlas ? atlas.manifest.cell.w / atlas.manifest.cell.h : 1.0;
  const brain = brainRef.current;
  const bubble = brain?.bubble;
  const chatOpen = !!brain?.chatOpen;
  const permission = brain?.permissions[0];
  const voiceBubble = bubble && (bubble.kind === 'transcript' || bubble.kind === 'confirm') ? bubble : null;
  const showReply = chatOpen && brain?.reply && !voiceBubble;
  const spriteW = Math.round(size * aspect);

  return (
    <div className={`companion ${chatOpen ? 'chat-open' : ''}`} onContextMenu={onContextMenu}>
      <div className="bubble-zone">
        {permission ? (
          <PermissionCard req={permission} count={brain!.permissions.length} onAnswer={(allow, remember) => void brain!.answerPermission(permission.id, allow, remember)} />
        ) : showReply ? (
          <ReplyBubble reply={brain!.reply!} onRetry={() => void brain!.retry()} onFix={(p) => brain!.openFix(p)} />
        ) : (
          bubble && (
            <div className={`bubble bubble-${bubble.kind}`} role="status" aria-live="polite">
              <div className="bubble-text">{bubble.text}</div>
              {bubble.hint && <div className="bubble-hint">{bubble.hint}</div>}
              {bubble.kind === 'error' && bubble.fix && (
                <div className="bubble-actions">
                  <button onClick={() => brain?.openFix(bubble.fix!)}>Open settings</button>
                  <button className="ghost" onClick={() => brain?.clearBubble('error')}>
                    Dismiss
                  </button>
                </div>
              )}
              {bubble.kind === 'confirm' && (
                <div className="bubble-actions">
                  <button onClick={() => void brain?.confirmPending(true)}>Send</button>
                  <button className="ghost" onClick={() => void brain?.confirmPending(false)}>
                    Discard
                  </button>
                </div>
              )}
            </div>
          )
        )}
      </div>
      {chatOpen && brain && <ChatBox busy={brain.busy} onSend={(t) => brain.sendText(t)} onStop={() => brain.stopAll()} onClose={() => brain.setChatOpen(false)} />}
      <div className="stage" style={{ width: spriteW, height: size }}>
        <canvas
          ref={canvasRef}
          className="sprite"
          style={{ height: size, width: spriteW, opacity }}
          onMouseDown={onMouseDown}
          onMouseMove={onMouseMove}
          onMouseUp={onMouseUp}
          onDoubleClick={onDoubleClick}
          aria-label="Noli"
        />
        <button
          type="button"
          className={`chat-button ${chatOpen ? 'on' : ''}`}
          title={chatOpen ? 'Close chatbox (Esc)' : 'Talk to Noli'}
          aria-label={chatOpen ? 'Close chatbox' : 'Open chatbox'}
          onClick={() => brain?.setChatOpen(!brain.chatOpen)}
        >
          <UiSprite name="bubble" scale={0.55} />
        </button>
      </div>
    </div>
  );
}

function ChatBox({ busy, onSend, onStop, onClose }: { busy: boolean; onSend: (t: string) => Promise<boolean>; onStop: () => void; onClose: () => void }) {
  const [text, setText] = useState('');
  const ref = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    const t = setTimeout(() => ref.current?.focus(), 60);
    return () => clearTimeout(t);
  }, []);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    // one line by default, grow up to four lines while typing
    el.style.height = '18px';
    if (el.scrollHeight > 20) el.style.height = `${Math.min(72, el.scrollHeight)}px`;
  }, [text]);
  const submit = async () => {
    const t = text.trim();
    if (!t || busy) return;
    setText('');
    if (!(await onSend(t))) setText(t);
    ref.current?.focus();
  };
  return (
    <div className="chatbox">
      <span className="chatbox-glyph" aria-hidden>
        {busy ? '◌' : '>'}
      </span>
      <textarea
        ref={ref}
        rows={1}
        value={text}
        spellCheck={false}
        placeholder={busy ? 'it is answering…' : 'say something…'}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
            e.preventDefault();
            void submit();
          }
        }}
      />
      <button
        className="chatbox-btn screen-glance"
        onClick={() => {
          const prompt = text.trim() ? `${text.trim()} (look at my screen)` : 'Look at my screen and tell me what you see or help me with what I am doing.';
          setText('');
          void onSend(prompt);
        }}
        disabled={busy}
        title="See my screen"
        aria-label="See my screen"
      >
        <svg width="14" height="14" viewBox="0 0 14 14" fill="currentColor" aria-hidden shapeRendering="crispEdges">
          <rect x="4" y="3" width="6" height="1" />
          <rect x="2" y="4" width="2" height="1" />
          <rect x="10" y="4" width="2" height="1" />
          <rect x="1" y="5" width="1" height="4" />
          <rect x="12" y="5" width="1" height="4" />
          <rect x="5" y="5" width="4" height="4" />
          <rect x="2" y="9" width="2" height="1" />
          <rect x="10" y="9" width="2" height="1" />
          <rect x="4" y="10" width="6" height="1" />
        </svg>
      </button>
      {busy ? (
        <button className="chatbox-btn stop" onClick={onStop} title="Stop" aria-label="Stop">
          ■
        </button>
      ) : (
        <button className="chatbox-btn" onClick={() => void submit()} disabled={!text.trim()} title="Send (Enter)" aria-label="Send">
          ↵
        </button>
      )}
      <button className="chatbox-btn ghost" onClick={onClose} title="Close (Esc)" aria-label="Close chatbox">
        ×
      </button>
    </div>
  );
}

function ReplyBubble({ reply, onRetry, onFix }: { reply: Reply; onRetry: () => void; onFix: (p: FixPage) => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const text = hideMemoryTags(reply.text).trim();
  // a slow model shows how long it has been waiting
  const [, tick] = useState(0);
  const waiting = reply.status === 'streaming' && !text;
  useEffect(() => {
    if (!waiting) return;
    const t = setInterval(() => tick((n) => n + 1), 1000);
    return () => clearInterval(t);
  }, [waiting]);
  const secs = Math.floor((performance.now() - reply.startedAt) / 1000);
  useLayoutEffect(() => {
    const el = ref.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [text]);
  return (
    <div className={`bubble bubble-reply ${reply.status === 'error' ? 'bubble-error' : ''}`} role="status" aria-live="polite">
      <div className="reply-text selectable" ref={ref}>
        {text || (reply.status === 'streaming' ? <span className="reply-dots">{reply.tool ? `⚙ ${reply.tool}` : secs >= 4 ? `thinking · ${secs}s` : 'thinking'}</span> : null)}
        {reply.status === 'streaming' && text && <span className="reply-cursor" />}
        {reply.status === 'cancelled' && <span className="reply-note"> — cut off</span>}
      </div>
      {reply.status === 'streaming' && text && reply.tool && <div className="reply-tool">⚙ {reply.tool}</div>}
      {reply.status === 'error' && (
        <div className="reply-error">
          <span>{reply.error ?? 'Something went wrong.'}</span>
          {reply.fix && <button onClick={() => onFix(reply.fix!)}>Settings</button>}
          <button onClick={onRetry}>Retry</button>
        </div>
      )}
    </div>
  );
}

function PermissionCard({ req, count, onAnswer }: { req: PermissionRequest; count: number; onAnswer: (allow: boolean, remember?: boolean) => void }) {
  const isBash = req.toolName === 'Bash';
  return (
    <div className="bubble bubble-permission" role="alertdialog" aria-label="Permission requested">
      <div className="perm-head">
        THE AGENT WANTS TO USE <b>{req.toolName}</b>
        {count > 1 && <span className="perm-more"> +{count - 1}</span>}
      </div>
      {req.summary && <div className="perm-what selectable">{req.summary}</div>}
      <div className="perm-where">in {req.workspace || 'its workspace'}</div>
      <div className="bubble-actions">
        <button onClick={() => onAnswer(true)}>Allow</button>
        <button className="ghost" onClick={() => onAnswer(true, true)} title={isBash ? 'Allow this exact command until PHANTOM quits' : `Allow ${req.toolName} until PHANTOM quits`}>
          Always
        </button>
        <button className="ghost danger" onClick={() => onAnswer(false)}>
          Deny
        </button>
      </div>
    </div>
  );
}
