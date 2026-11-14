import React, { useEffect, useRef, useState, type ReactNode } from "react";
import { callable, definePlugin } from "@decky/api";
import { DialogButton, Focusable, PanelSection, PanelSectionRow, TextField, showModal, staticClasses } from "@decky/ui";
import { WideModal } from "./wide-modal";

interface Player {
  id: string;
  name: string;
  avatar?: string;
  status?: string;
  game?: string;
  level?: number;
}
interface Session { me: Player; friends: Player[] }
interface ChatId { id: string; thread: string }
interface Message { id: string; text?: string; sender: string; name?: string; date?: string }
interface Chat extends ChatId { name?: string; members: Player[]; unread: boolean; latest?: Message }
interface Party { id: string; name?: string; members: Player[]; invited: boolean }

const api = {
  load: callable<[], Session | null>("load"),
  signIn: callable<[string], void>("sign_in"),
  signOut: callable<[], void>("sign_out"),
  search: callable<[string], Player[]>("search"),
  relationships: callable<[boolean], Player[]>("relationships"),
  inbox: callable<[], Chat[]>("inbox"),
  createChat: callable<[string], ChatId>("create_chat"),
  messages: callable<[string, string], Message[]>("messages"),
  send: callable<[string, string, string], void>("send_message"),
  parties: callable<[], Party[]>("parties"),
  createParty: callable<[boolean], string>("create_party"),
  join: callable<[string], void>("join_party"),
  leave: callable<[string], void>("leave_party"),
  invite: callable<[string, string], void>("invite"),
};

function useTask() {
  const pending = useRef(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function run(task: () => Promise<void>) {
    if (pending.current) return;
    pending.current = true;
    setBusy(true);
    setError("");
    try { await task(); }
    catch (failure) { setError(failure instanceof Error ? failure.message : String(failure)); }
    finally {
      pending.current = false;
      setBusy(false);
    }
  }
  return { run, busy, error };
}

const rowStyles = `
  .psn-social-player { display: flex; gap: 8px; align-items: center; min-width: 0; width: 100%; text-align: left; }
  .psn-social-player-avatar { width: 36px; height: 36px; flex: 0 0 36px; display: grid; place-items: center; position: relative; overflow: hidden; border-radius: 50%; background: #364b64; color: #fff; }
  .psn-social-player-avatar img { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: cover; }
  .psn-social-player-copy { display: grid; min-width: 0; }
  .psn-social-player-copy > * { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .psn-social-player-subtitle { font-size: 12px; opacity: .78; }
  button:is(:focus, .gpfocus) .psn-social-player-subtitle { opacity: 1; }
`;

function PlayerRow({ player, detail, action, disabled }: {
  player: Player; detail?: string; action?: () => void; disabled?: boolean;
}) {
  const content = <span className="psn-social-player">
    <span className="psn-social-player-avatar" aria-hidden="true">
      {player.name.slice(0, 1).toUpperCase()}
      {player.avatar && <img src={player.avatar} alt="" referrerPolicy="no-referrer"
        onError={event => { event.currentTarget.hidden = true; }} />}
    </span>
    <span className="psn-social-player-copy">
      <strong>{player.name}</strong>
      <span className="psn-social-player-subtitle">{detail ?? [player.status, player.game].filter(Boolean).join(" · ")}</span>
    </span>
  </span>;
  return action ? <DialogButton style={{ width: "100%" }} onClick={action} disabled={disabled}>{content}</DialogButton> : content;
}

function Dialog({ closeModal, title, children }: { closeModal?: () => void; title: string; children: ReactNode }) {
  return <WideModal closeModal={closeModal}>
    <Focusable flow-children="column" style={{ display: "flex", flexDirection: "column", gap: 8, minWidth: 0, maxHeight: "70vh", overflowY: "auto" }}
      onFocus={event => { if (event.currentTarget !== event.target) event.target.scrollIntoView({ block: "nearest" }); }}>
      <style>{rowStyles}</style>
      <h2 style={{ margin: 0 }}>{title}</h2>
      {children}
    </Focusable>
  </WideModal>;
}

function Conversation({ me, title, chat, closeModal, changed }: {
  me: string; title: string; chat: ChatId; closeModal?: () => void; changed(): void;
}) {
  const { run, busy, error } = useTask();
  const [messages, setMessages] = useState<Message[]>([]);
  const [draft, setDraft] = useState("");
  const history = useRef<HTMLDivElement>(null);
  async function refresh() {
    setMessages(await api.messages(chat.id, chat.thread));
  }
  useEffect(() => { void run(refresh); }, []);
  useEffect(() => {
    if (history.current) history.current.scrollTop = history.current.scrollHeight;
  }, [messages]);

  return <Dialog title={title} closeModal={closeModal}>
    <DialogButton disabled={busy} onClick={() => void run(refresh)}>Refresh conversation</DialogButton>
    <div ref={history} role="log" aria-label="Conversation" tabIndex={0} style={{ minHeight: 100, overflowY: "auto" }}>
      {!messages.length && <p>{busy ? "Loading conversation…" : "No messages."}</p>}
      {messages.map((item, index) => <div key={item.id || index} style={{
        display: "flex", flexDirection: "column", alignItems: item.sender === me ? "flex-end" : "flex-start", margin: 8,
      }}>
        <small>{item.sender === me ? "You" : item.name}</small>
        <span style={{ padding: "6px 10px", borderRadius: 10, background: item.sender === me ? "#235b93" : "#343e49", overflowWrap: "anywhere", maxWidth: "85%" }}>
          {item.text ?? "Attachment or system message"}
        </span>
      </div>)}
    </div>
    {error && <div role="alert">{error}</div>}
    <TextField label="Message" value={draft} disabled={busy}
      onChange={event => setDraft([...event.currentTarget.value].slice(0, 256).join(""))} />
    <DialogButton disabled={busy || !draft.trim()} onClick={() => void run(async () => {
      await api.send(chat.id, chat.thread, draft);
      setDraft("");
      changed();
      await refresh();
    })}>Send message</DialogButton>
  </Dialog>;
}

function SearchDialog({ openChat, closeModal }: { openChat(player: Player): void; closeModal?: () => void }) {
  const { run, busy, error } = useTask();
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<Player[]>();
  return <Dialog title="Search PlayStation Network" closeModal={closeModal}>
    <TextField label="Online ID" value={query} disabled={busy} onChange={event => setQuery(event.currentTarget.value)} />
    <DialogButton disabled={busy || !query.trim()} onClick={() => void run(async () => {
      setResults(await api.search(query.trim()));
    })}>Search</DialogButton>
    {busy && <div role="status">Searching…</div>}
    {error && <div role="alert">{error}</div>}
    {results?.length === 0 && <div>No players found.</div>}
    {results?.map(player => <PlayerRow key={player.id} player={player} disabled={busy} action={() => {
      closeModal?.();
      openChat(player);
    }} />)}
  </Dialog>;
}

function InviteDialog({ party, friends, closeModal }: { party: Party; friends: Player[]; closeModal?: () => void }) {
  const { run, busy, error } = useTask();
  const [sent, setSent] = useState<string[]>([]);
  const available = friends.filter(friend => !party.members.some(member => member.id === friend.id));
  return <Dialog title="Invite friends" closeModal={closeModal}>
    {error && <div role="alert">{error}</div>}
    {!available.length && <div>No friends available to invite.</div>}
    {available.map(player => <PlayerRow key={player.id} player={player}
      detail={sent.includes(player.id) ? "Invitation sent" : undefined}
      disabled={busy || sent.includes(player.id)} action={() => void run(async () => {
        await api.invite(party.id, player.id);
        setSent(previous => [...previous, player.id]);
      })} />)}
  </Dialog>;
}

function RelationshipsDialog({ closeModal }: { closeModal?: () => void }) {
  const { run, busy, error } = useTask();
  const [blocked, setBlocked] = useState(false);
  const [players, setPlayers] = useState<Player[]>();
  function load(showBlocked: boolean) {
    void run(async () => {
      setBlocked(showBlocked);
      setPlayers(undefined);
      setPlayers(await api.relationships(showBlocked));
    });
  }
  useEffect(() => { load(false); }, []);
  return <Dialog title="Friend requests and blocked players" closeModal={closeModal}>
    <Focusable flow-children="row" style={{ display: "flex", flexWrap: "wrap", gap: 4 }}>
      <DialogButton disabled={busy} aria-pressed={!blocked} onClick={() => load(false)}>Incoming requests</DialogButton>
      <DialogButton disabled={busy} aria-pressed={blocked} onClick={() => load(true)}>Blocked players</DialogButton>
    </Focusable>
    {busy && <div role="status">Loading…</div>}
    {error && <div role="alert">{error}</div>}
    {players?.length === 0 && <div>{blocked ? "No blocked players." : "No incoming requests."}</div>}
    {players?.map(player => <PlayerRow key={player.id} player={player} />)}
  </Dialog>;
}

type Tab = "Friends" | "Messages" | "Parties";
const tabs: Tab[] = ["Friends", "Messages", "Parties"];

function SocialPanel() {
  const { run, busy, error } = useTask();
  const [session, setSession] = useState<Session | null>();
  const [code, setCode] = useState("");
  const [tab, setTab] = useState<Tab>("Friends");
  const [inbox, setInbox] = useState<Chat[]>();
  const [parties, setParties] = useState<Party[]>();
  const [inboxDirty, setInboxDirty] = useState(false);
  useEffect(() => { void run(async () => setSession(await api.load())); }, []);

  function title(chat: Chat, me: Player) {
    return chat.name || chat.members.filter(member => member.id !== me.id).map(member => member.name).join(", ") || "Conversation";
  }

  function openChat(chat: ChatId, label: string, me: Player) {
    showModal(<Conversation me={me.id} title={label} chat={chat} changed={() => setInboxDirty(true)} />);
  }

  function messagePlayer(player: Player) {
    if (!session || player.id === session.me.id) return;
    void run(async () => {
      const chats = await api.inbox();
      const existing = chats.find(chat => chat.members.length === 2 &&
        chat.members.some(member => member.id === player.id) && chat.members.some(member => member.id === session.me.id));
      openChat(existing ?? await api.createChat(player.id), player.name, session.me);
    });
  }

  async function loadTab(next: Tab) {
    if (next === "Friends") setSession(await api.load());
    if (next === "Messages") {
      setInbox(await api.inbox());
      setInboxDirty(false);
    }
    if (next === "Parties") setParties(await api.parties());
  }

  function partyAction(action: () => Promise<unknown>) {
    void run(async () => {
      await action();
      await loadTab("Parties");
    });
  }

  return <PanelSection>
    <style>{rowStyles}</style>
    {!session && <>
      <PanelSectionRow>
        <DialogButton onClick={() => window.SteamClient.System.OpenInSystemBrowser("https://ca.account.sony.com/api/v1/ssocookie")}>
          Get Sony NPSSO code
        </DialogButton>
      </PanelSectionRow>
      <PanelSectionRow><TextField bIsPassword label="Sony NPSSO code" value={code} onChange={event => setCode(event.currentTarget.value)} /></PanelSectionRow>
      <PanelSectionRow><DialogButton disabled={busy || !code.trim()} onClick={() => void run(async () => {
        await api.signIn(code);
        setCode("");
        setSession(await api.load());
      })}>Connect PlayStation Network</DialogButton></PanelSectionRow>
      <PanelSectionRow><DialogButton disabled={busy} onClick={() => void run(async () => setSession(await api.load()))}>Retry</DialogButton></PanelSectionRow>
    </>}
    {session && <>
      <PanelSectionRow><PlayerRow player={session.me} detail={session.me.level ? `Trophy level ${session.me.level}` : undefined} /></PanelSectionRow>
      <PanelSectionRow><Focusable flow-children="row" style={{ display: "flex", flexWrap: "wrap", gap: 4 }}>
        <DialogButton disabled={busy} onClick={() => showModal(<RelationshipsDialog />)}>Manage friends</DialogButton>
        {tabs.map(next => <DialogButton key={next} aria-pressed={tab === next} disabled={busy} onClick={() => {
          setTab(next);
          if ((next === "Messages" && (!inbox || inboxDirty)) || (next === "Parties" && !parties)) {
            void run(() => loadTab(next));
          }
        }}>{next}</DialogButton>)}
      </Focusable></PanelSectionRow>
      <PanelSectionRow><Focusable flow-children="row" style={{ display: "flex", flexWrap: "wrap", gap: 4 }}>
        <DialogButton disabled={busy} onClick={() => showModal(<SearchDialog openChat={messagePlayer} />)}>Search</DialogButton>
        <DialogButton disabled={busy} onClick={() => void run(() => loadTab(tab))}>Refresh</DialogButton>
      </Focusable></PanelSectionRow>
      {tab === "Friends" && <>
        {!session.friends.length && <PanelSectionRow>No friends found.</PanelSectionRow>}
        {[...session.friends].sort((a, b) => a.name.localeCompare(b.name)).map(player =>
          <PanelSectionRow key={player.id}><PlayerRow player={player} disabled={busy} action={() => messagePlayer(player)} /></PanelSectionRow>)}
      </>}
      {tab === "Messages" && <>
        {inbox?.length === 0 && <PanelSectionRow>No conversations.</PanelSectionRow>}
        {inbox?.map(chat => {
          const peer = chat.members.find(member => member.id !== session.me.id);
          const name = title(chat, session.me);
          const preview = chat.latest?.text ?? (chat.latest ? "Attachment or system message" : "No messages");
          return <PanelSectionRow key={chat.id}><PlayerRow player={{ id: chat.id, name, avatar: peer?.avatar }}
            detail={chat.unread ? `● ${preview}` : preview} disabled={busy}
            action={() => openChat(chat, name, session.me)} /></PanelSectionRow>;
        })}
      </>}
      {tab === "Parties" && <>
        <PanelSectionRow>Voice chat is available in PlayStation App.</PanelSectionRow>
        <PanelSectionRow><DialogButton disabled={busy} onClick={() => partyAction(() => api.createParty(false))}>Create invite-only party</DialogButton></PanelSectionRow>
        <PanelSectionRow><DialogButton disabled={busy} onClick={() => partyAction(() => api.createParty(true))}>Create friends-only party</DialogButton></PanelSectionRow>
        {parties?.length === 0 && <PanelSectionRow>No parties or invitations.</PanelSectionRow>}
        {parties?.map(party => {
          const member = party.members.some(player => player.id === session.me.id);
          return <PanelSectionRow key={party.id}><Focusable flow-children="column" style={{ display: "grid", gap: 4 }}>
            <strong>{party.name || "PlayStation party"}</strong>
            {party.members.map(player => <PlayerRow key={player.id} player={player} />)}
            {member ? <>
              <DialogButton disabled={busy} onClick={() => showModal(<InviteDialog party={party} friends={session.friends} />)}>Invite friends</DialogButton>
              <DialogButton disabled={busy} onClick={() => partyAction(() => api.leave(party.id))}>Leave party</DialogButton>
            </> : <DialogButton disabled={busy} onClick={() => partyAction(() => api.join(party.id))}>{party.invited ? "Accept invitation" : "Join party"}</DialogButton>}
          </Focusable></PanelSectionRow>;
        })}
      </>}
      <PanelSectionRow><DialogButton disabled={busy} onClick={() => void run(async () => {
        await api.signOut();
        setSession(null);
        setInbox(undefined);
        setParties(undefined);
        setTab("Friends");
      })}>Disconnect PlayStation Network</DialogButton></PanelSectionRow>
    </>}
    {busy && <PanelSectionRow><div role="status">Working…</div></PanelSectionRow>}
    {error && <PanelSectionRow><div role="alert">{error}</div></PanelSectionRow>}
  </PanelSection>;
}

export default definePlugin(() => ({
  name: "PlayDeck",
  titleView: <div className={staticClasses.Title}>PlayDeck</div>,
  content: <SocialPanel />,
  icon: <svg width="1em" height="1em" viewBox="0 0 24 24" fill="none" stroke="currentColor"
    strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <rect x="1" y="5" width="22" height="14" rx="4" />
    <rect x="8" y="8" width="8" height="8" rx="1" />
    <path d="M3.5 10h2.5m-1.25-1.25v2.5" />
    <rect x="3.5" y="13.5" width="2.5" height="2.5" rx=".5" />
    <path d="m19.5 8 1.35 2.4h-2.7L19.5 8Z" strokeWidth="1" />
    <circle cx="20.5" cy="13" r="1" strokeWidth="1" />
    <path d="m18.15 15.05 1.7 1.7m0-1.7-1.7 1.7" strokeWidth="1" />
  </svg>,
}));
