import { useEffect, useRef, useState } from 'react';
import { generateNewIdentity, restoreIdentityFromMnemonic, signChallenge, type UserIdentity } from './identity';
import {
  blockedArray,
  connectAccountSync,
  disconnectAccountSync,
  exportEncryptedSnapshot,
  friendsArray,
  importEncryptedSnapshot,
  profileMap,
  serversArray,
  snapshotServersArray,
  ydoc
} from './profileStore';
import { resizeImageToDataUrl } from './avatarHelper';
import { P2PDMSession, type DmMessage, type PeerProfile } from './p2pDm';
import { VoiceManager } from './voiceManager';

interface ServerUser {
  publicKey: string;
  username: string;
  bio: string;
  avatar?: string;
}

interface ExtendedProfile extends PeerProfile {
  friends?: string[];
  joinedAt?: number;
}

interface ChatMessage {
  id: string;
  channel?: string;
  senderKey: string;
  targetKey?: string;
  senderName?: string;
  senderAvatar?: string;
  text: string;
  timestamp: number;
}

interface ServerStats {
  largestVoiceCall: number;
  longestVoiceCallSeconds: number;
  serverStreaks: Record<string, { count: number; lastDate: string }>;
  dmStreaks: Record<string, { count: number; lastDate: string }>;
}

interface ServerConfig {
  serverName: string;
  channels: string[];
  allowSnapshots: boolean;
  whitelistEnabled: boolean;
  whitelist: string[];
  blacklist: string[];
  admins: string[];
}

export default function App() {
  const [identity, setIdentity] = useState<UserIdentity | null>(null);
  const [isLoggingIn, setIsLoggingIn] = useState(false);
  const [seedInput, setSeedInput] = useState('');
  const [copiedId, setCopiedId] = useState(false);
  
  // Local CRDT Profile State
  const [username, setUsername] = useState('');
  const [bio, setBio] = useState('');
  const [avatar, setAvatar] = useState('');
  const [servers, setServers] = useState<string[]>([]);
  const [friends, setFriends] = useState<string[]>([]);
  const [blocked, setBlocked] = useState<string[]>([]);
  const [snapshotServers, setSnapshotServers] = useState<string[]>([]);
  const [newServerUrl, setNewServerUrl] = useState('ws://localhost:8080');

  // Navigation Mode: 'server' | 'dm' | 'admin'
  const [viewMode, setViewMode] = useState<'server' | 'dm' | 'admin'>('server');

  // Discord-style Profile Popover Modal State (Click any user to inspect!)
  const [inspectedUserKey, setInspectedUserKey] = useState<string | null>(null);

  // Active Community Server State
  const [activeServerUrl, setActiveServerUrl] = useState<string | null>(null);
  const [connStatus, setConnStatus] = useState<'disconnected' | 'connecting' | 'connected' | 'error'>('disconnected');
  const [connError, setConnError] = useState('');
  const [serverName, setServerName] = useState('');
  const [channels, setChannels] = useState<string[]>(['general']);
  const [activeChannel, setActiveChannel] = useState('general');
  const [serverUsers, setServerUsers] = useState<ServerUser[]>([]);
  const [serverProfiles, setServerProfiles] = useState<Record<string, ExtendedProfile>>({});
  const [voiceUsers, setVoiceUsers] = useState<string[]>([]);
  const [serverStats, setServerStats] = useState<ServerStats>({
    largestVoiceCall: 0,
    longestVoiceCallSeconds: 0,
    serverStreaks: {},
    dmStreaks: {}
  });
  const [serverConfig, setServerConfig] = useState<ServerConfig | null>(null);

  // Admin Panel Inputs
  const [newChannelInput, setNewChannelInput] = useState('');
  const [newAdminInput, setNewAdminInput] = useState('');
  
  // Voice Controls
  const [inVoice, setInVoice] = useState(false);
  const [isMuted, setIsMuted] = useState(false);
  const [isDeafened, setIsDeafened] = useState(false);

  // Messages & DMs
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [serverDms, setServerDms] = useState<ChatMessage[]>([]);
  const [p2pDmMessages, setP2pDmMessages] = useState<DmMessage[]>([]);
  const [dmProfiles, setDmProfiles] = useState<Record<string, PeerProfile>>({});
  const [activeFriendKey, setActiveFriendKey] = useState<string | null>(null);
  const [chatInput, setChatInput] = useState('');

  const wsRef = useRef<WebSocket | null>(null);
  const voiceRef = useRef<VoiceManager | null>(null);
  const dmSessionRef = useRef<P2PDMSession | null>(null);
  const chatBottomRef = useRef<HTMLDivElement | null>(null);

  const activateSession = (id: UserIdentity) => {
    connectAccountSync(id.publicKeyHex, id.mnemonic);
    setIdentity(id);
  };

  useEffect(() => {
    const savedSeed = localStorage.getItem('local_seed_phrase');
    if (savedSeed) {
      restoreIdentityFromMnemonic(savedSeed).then(activateSession);
    }
    return () => disconnectAccountSync();
  }, []);

  useEffect(() => {
    chatBottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, serverDms, p2pDmMessages, activeChannel, viewMode, activeFriendKey]);

  useEffect(() => {
    if (!identity) return;

    const updateUI = async () => {
      const currentName = profileMap.get('username') || 'Anonymous';
      const currentBio = profileMap.get('bio') || '';
      const currentAvatar = profileMap.get('avatar') || '';
      const currentFriends = friendsArray.toArray();
      const currentSnapshots = snapshotServersArray.toArray();

      setUsername(currentName);
      setBio(currentBio);
      setAvatar(currentAvatar);
      setServers(serversArray.toArray());
      setFriends(currentFriends);
      setBlocked(blockedArray.toArray());
      setSnapshotServers(currentSnapshots);

      if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
        wsRef.current.send(JSON.stringify({
          type: 'PROFILE_UPDATE',
          username: currentName,
          bio: currentBio,
          avatar: currentAvatar,
          friends: currentFriends
        }));

        // If user enabled Encrypted Snapshot for this server, push encrypted backup!
        if (activeServerUrl && currentSnapshots.includes(activeServerUrl)) {
          const encryptedHex = await exportEncryptedSnapshot(identity.privateKey);
          wsRef.current.send(JSON.stringify({ type: 'SAVE_SNAPSHOT', encryptedHex }));
        }
      }

      if (dmSessionRef.current) {
        dmSessionRef.current.publishMyProfile(identity.publicKeyHex, {
          username: currentName,
          bio: currentBio,
          avatar: currentAvatar
        });
      }
    };

    ydoc.on('update', updateUI);
    updateUI();

    return () => {
      ydoc.off('update', updateUI);
    };
  }, [identity, activeServerUrl]);

  const copyToClipboard = (text: string) => {
    navigator.clipboard?.writeText(text).catch(() => {});
    setCopiedId(true);
    setTimeout(() => setCopiedId(false), 1800);
  };

  const handleAvatarUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const compressedDataUrl = await resizeImageToDataUrl(file, 96);
    profileMap.set('avatar', compressedDataUrl);
  };

  const handleChatImageUpload = async (file: File) => {
    const compressedImg = await resizeImageToDataUrl(file, 320);
    if (viewMode === 'server' && wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({
        type: 'CHAT_MESSAGE',
        channel: activeChannel,
        text: compressedImg
      }));
    } else if (viewMode === 'dm' && activeFriendKey && identity) {
      if (wsRef.current?.readyState === WebSocket.OPEN) {
        wsRef.current.send(JSON.stringify({
          type: 'DIRECT_MESSAGE',
          targetKey: activeFriendKey,
          text: compressedImg
        }));
      } else if (dmSessionRef.current) {
        dmSessionRef.current.sendMessage(identity.publicKeyHex, compressedImg);
      }
    }
  };

  const deleteMessage = (messageId: string) => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({ type: 'DELETE_MESSAGE', messageId }));
    }
  };

  const toggleBlockUser = (targetKey: string) => {
    const arr = blockedArray.toArray();
    const idx = arr.indexOf(targetKey);
    if (idx !== -1) blockedArray.delete(idx, 1);
    else blockedArray.push([targetKey]);
  };

  const toggleFriend = (targetKey: string) => {
    const arr = friendsArray.toArray();
    const idx = arr.indexOf(targetKey);
    if (idx !== -1) friendsArray.delete(idx, 1);
    else friendsArray.push([targetKey]);
  };

  const toggleServerSnapshot = (serverUrl: string) => {
    const arr = snapshotServersArray.toArray();
    const idx = arr.indexOf(serverUrl);
    if (idx !== -1) snapshotServersArray.delete(idx, 1);
    else snapshotServersArray.push([serverUrl]);
  };

  const sendAdminAction = (payload: Record<string, any>) => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({ type: 'ADMIN_ACTION', ...payload }));
    }
  };

  const removeServer = (idx: number, e: React.MouseEvent) => {
    e.stopPropagation();
    serversArray.delete(idx, 1);
  };

  const removeFriend = (idx: number, e: React.MouseEvent) => {
    e.stopPropagation();
    friendsArray.delete(idx, 1);
  };

  const getDmStreak = (friendKey: string): number => {
    if (!identity || !serverStats.dmStreaks) return 0;
    const pairKey = [identity.publicKeyHex, friendKey].sort().join('-');
    return serverStats.dmStreaks[pairKey]?.count || 0;
  };

  const connectToServer = (url: string) => {
    if (!identity) return;
    leaveVoice();
    if (wsRef.current) {
      wsRef.current.onclose = null;
      wsRef.current.close();
    }

    setViewMode('server');
    setActiveServerUrl(url);
    setConnStatus('connecting');
    setConnError('');

    const cached = localStorage.getItem(`chap-cache-${url}`);
    if (cached) {
      try {
        const parsed = JSON.parse(cached);
        setServerName(parsed.serverName || url);
        setChannels(parsed.channels || ['general']);
        setMessages(parsed.messages || []);
        setServerProfiles(parsed.profiles || {});
      } catch (e) {}
    } else {
      setServerName(url);
      setMessages([]);
    }

    const ws = new WebSocket(url);
    wsRef.current = ws;

    ws.onmessage = async (event) => {
      try {
        const data = JSON.parse(event.data);

        if (data.type === 'AUTH_CHALLENGE') {
          const signature = await signChallenge(data.challenge, identity.privateKey);
          ws.send(JSON.stringify({
            type: 'AUTH_RESPONSE',
            publicKey: identity.publicKeyHex,
            signature,
            username: profileMap.get('username') || 'Anonymous',
            bio: profileMap.get('bio') || '',
            avatar: profileMap.get('avatar') || '',
            friends: friendsArray.toArray()
          }));
        } else if (data.type === 'INIT_STATE') {
          setConnStatus('connected');
          setServerName(data.serverName);
          if (data.channels?.length) {
            setChannels(data.channels);
            setActiveChannel(data.channels[0]);
          }
          setMessages(data.messages || []);
          setServerDms(data.dms || []);
          if (data.profiles) setServerProfiles(data.profiles);
          if (data.stats) setServerStats(data.stats);
          if (data.serverConfig) setServerConfig(data.serverConfig);

          // If the server holds an Encrypted Snapshot of our account, decrypt and merge it!
          if (data.encryptedSnapshot) {
            await importEncryptedSnapshot(data.encryptedSnapshot, identity.privateKey);
          }

          localStorage.setItem(`chap-cache-${url}`, JSON.stringify({
            serverName: data.serverName,
            channels: data.channels,
            messages: data.messages,
            profiles: data.profiles
          }));
        } else if (data.type === 'USER_LIST') {
          setServerUsers(data.users || []);
          if (data.profiles) setServerProfiles(data.profiles);
          if (data.voiceUsers) setVoiceUsers(data.voiceUsers);
          if (data.stats) setServerStats(data.stats);
          if (data.serverConfig) {
            setServerConfig(data.serverConfig);
            setServerName(data.serverConfig.serverName);
            setChannels(data.serverConfig.channels);
          }
        } else if (data.type === 'STATS_UPDATE') {
          if (data.stats) setServerStats(data.stats);
        } else if (data.type === 'NEW_MESSAGE') {
          setMessages(prev => [...prev, data.message]);
        } else if (data.type === 'MESSAGE_DELETED') {
          setMessages(prev => prev.filter(m => m.id !== data.messageId));
        } else if (data.type === 'NEW_DM') {
          setServerDms(prev => prev.some(m => m.id === data.message.id) ? prev : [...prev, data.message]);
        } else if (data.type === 'DM_DELETED') {
          setServerDms(prev => prev.filter(m => m.id !== data.messageId));
        } else if (data.type === 'VOICE_PEER_JOINED') {
          voiceRef.current?.initiateCallToPeer(data.peerKey);
        } else if (data.type === 'VOICE_SIGNAL') {
          voiceRef.current?.handleIncomingSignal(data.fromKey, data.signal);
        } else if (data.type === 'ERROR') {
          alert(`Server Notice: ${data.message}`);
        }
      } catch (err: any) {
        setConnStatus('error');
        setConnError(err.message || 'Client error');
      }
    };

    ws.onerror = () => {
      setConnStatus('error');
      setConnError(`Offline Mode — Viewing cached messages`);
    };

    ws.onclose = () => {
      if (wsRef.current === ws) {
        setInVoice(false);
        setConnStatus(prev => (prev === 'error' ? 'error' : 'disconnected'));
      }
    };
  };

  const toggleVoice = async () => {
    if (!wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) return;
    if (inVoice) {
      leaveVoice();
    } else {
      try {
        const vm = new VoiceManager(wsRef.current);
        await vm.startLocalMic();
        voiceRef.current = vm;
        setInVoice(true);
        setIsMuted(false);
        setIsDeafened(false);
        wsRef.current.send(JSON.stringify({ type: 'VOICE_JOIN' }));
      } catch (err) {
        alert('Could not access microphone!');
      }
    }
  };

  const toggleMute = () => {
    if (!voiceRef.current) return;
    const next = !isMuted;
    voiceRef.current.setMuted(next);
    setIsMuted(next);
  };

  const toggleDeafen = () => {
    if (!voiceRef.current) return;
    const next = !isDeafened;
    voiceRef.current.setDeafened(next);
    setIsDeafened(next);
    if (next) setIsMuted(true);
  };

  const leaveVoice = () => {
    if (voiceRef.current) {
      voiceRef.current.stop();
      voiceRef.current = null;
    }
    if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({ type: 'VOICE_LEAVE' }));
    }
    setInVoice(false);
    setIsMuted(false);
    setIsDeafened(false);
  };

  const openDirectMessage = (friendKey: string) => {
    if (!identity) return;
    const cleanKey = friendKey.trim();
    if (!cleanKey || cleanKey === identity.publicKeyHex) return;

    if (!friendsArray.toArray().includes(cleanKey)) {
      friendsArray.push([cleanKey]);
    }

    if (dmSessionRef.current) dmSessionRef.current.destroy();

    setViewMode('dm');
    setActiveFriendKey(cleanKey);
    setInspectedUserKey(null);

    const session = new P2PDMSession(identity.publicKeyHex, cleanKey, () => {
      setP2pDmMessages(session.messagesArray.toArray());
      setDmProfiles(session.profilesMap.toJSON() as Record<string, PeerProfile>);
    });

    dmSessionRef.current = session;
    session.publishMyProfile(identity.publicKeyHex, {
      username: profileMap.get('username') || 'Anonymous',
      bio: profileMap.get('bio') || '',
      avatar: profileMap.get('avatar') || ''
    });

    setP2pDmMessages(session.messagesArray.toArray());
    setDmProfiles(session.profilesMap.toJSON() as Record<string, PeerProfile>);
  };

  const sendChatMessage = () => {
    if (!chatInput.trim() || !identity) return;

    if (viewMode === 'server' && wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({
        type: 'CHAT_MESSAGE',
        channel: activeChannel,
        text: chatInput
      }));
    } else if (viewMode === 'dm' && activeFriendKey) {
      if (wsRef.current?.readyState === WebSocket.OPEN) {
        wsRef.current.send(JSON.stringify({
          type: 'DIRECT_MESSAGE',
          targetKey: activeFriendKey,
          text: chatInput
        }));
      } else if (dmSessionRef.current) {
        dmSessionRef.current.sendMessage(identity.publicKeyHex, chatInput);
      }
    }
    setChatInput('');
  };

  const renderMessageContent = (text: string) => {
    if (text.startsWith('data:image/') || /^https?:\/\/.+\.(gif|png|jpg|jpeg|webp)(\?.*)?$/i.test(text)) {
      return <img src={text} alt="media" style={{ maxWidth: 280, maxHeight: 280, borderRadius: 8, marginTop: 6, display: 'block' }} />;
    }
    const urlRegex = /(https?:\/\/[^\s]+)/g;
    const parts = text.split(urlRegex);
    return (
      <div style={{ marginTop: 4, wordBreak: 'break-word' }}>
        {parts.map((part, i) => 
          urlRegex.test(part) ? (
            <a key={i} href={part} target="_blank" rel="noreferrer" style={{ color: '#64b5f6' }}>{part}</a>
          ) : (
            <span key={i}>{part}</span>
          )
        )}
      </div>
    );
  };

  const formatTime = (ts: number) => {
    if (!ts) return '';
    return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  };

  const handleCreateAccount = async () => {
    const id = await generateNewIdentity();
    localStorage.setItem('local_seed_phrase', id.mnemonic);
    activateSession(id);
    profileMap.set('username', 'Anonymous');
  };

  const handleImportAccount = async () => {
    try {
      const id = await restoreIdentityFromMnemonic(seedInput.trim());
      localStorage.setItem('local_seed_phrase', id.mnemonic);
      activateSession(id);
      setSeedInput('');
    } catch (err: any) {
      alert(err.message);
    }
  };

  const handleLogout = () => {
    leaveVoice();
    if (wsRef.current) {
      wsRef.current.onclose = null;
      wsRef.current.close();
    }
    if (dmSessionRef.current) dmSessionRef.current.destroy();
    disconnectAccountSync();
    localStorage.removeItem('local_seed_phrase');
    setIdentity(null);
    setIsLoggingIn(false);
  };

  if (!identity) {
    return (
      <div style={{ padding: 32, fontFamily: 'sans-serif', maxWidth: 420, margin: '40px auto', textAlign: 'center' }}>
        <h2>Welcome to Chap</h2>
        {!isLoggingIn ? (
          <div>
            <p style={{ color: '#aaa', marginBottom: 24 }}>
              Your account lives entirely on your devices. No central servers, no emails, no phone numbers.
            </p>
            <button onClick={handleCreateAccount} style={{ width: '100%', padding: '12px 16px', fontSize: 16, cursor: 'pointer', marginBottom: 16 }}>
              Create New Account
            </button>
            <p style={{ fontSize: 14 }}>
              Already have an account?{' '}
              <button onClick={() => setIsLoggingIn(true)} style={{ background: 'none', border: 'none', color: '#646cff', cursor: 'pointer', textDecoration: 'underline', padding: 0 }}>
                Log in here
              </button>
            </p>
          </div>
        ) : (
          <div>
            <p style={{ color: '#aaa', marginBottom: 16 }}>
              Enter your 12-word recovery phrase to link this device to your account.
            </p>
            <textarea
              rows={3}
              value={seedInput}
              onChange={e => setSeedInput(e.target.value)}
              placeholder="unaware analyst push ignore..."
              style={{ width: '100%', padding: 10, marginBottom: 12, boxSizing: 'border-box' }}
            />
            <button onClick={handleImportAccount} style={{ width: '100%', padding: '12px 16px', fontSize: 16, cursor: 'pointer', marginBottom: 16 }}>
              Sync & Log In
            </button>
            <p style={{ fontSize: 14 }}>
              Need a new account instead?{' '}
              <button onClick={() => setIsLoggingIn(false)} style={{ background: 'none', border: 'none', color: '#646cff', cursor: 'pointer', textDecoration: 'underline', padding: 0 }}>
                Create one
              </button>
            </p>
          </div>
        )}
      </div>
    );
  }

  const isMeAdmin = Boolean(serverConfig?.admins?.includes(identity.publicKeyHex));
  const channelMessages = messages.filter(
    m => (m.channel || 'general') === activeChannel && !blocked.includes(m.senderKey)
  );

  const combinedDmMessages = [
    ...serverDms.filter(
      m => (m.senderKey === identity.publicKeyHex && m.targetKey === activeFriendKey) ||
           (m.senderKey === activeFriendKey && m.targetKey === identity.publicKeyHex)
    ),
    ...p2pDmMessages
  ].sort((a, b) => a.timestamp - b.timestamp);

  const incomingRequests = Array.from(
    new Set(
      serverDms
        .filter(m => m.targetKey === identity.publicKeyHex && !friends.includes(m.senderKey) && !blocked.includes(m.senderKey))
        .map(m => m.senderKey)
    )
  );

  // Inspected User Modal Data (Discord-style Profile Card)
  const inspectedProfile = inspectedUserKey
    ? (inspectedUserKey === identity.publicKeyHex
        ? { username, bio, avatar, friends, joinedAt: serverProfiles[identity.publicKeyHex]?.joinedAt }
        : (serverProfiles[inspectedUserKey] || dmProfiles[inspectedUserKey]))
    : null;

  const mutualFriends = inspectedUserKey && inspectedProfile?.friends
    ? friends.filter(fKey => inspectedProfile.friends?.includes(fKey))
    : [];

  return (
    <div style={{ display: 'flex', height: '100vh', width: '100vw', overflow: 'hidden', fontFamily: 'sans-serif', textAlign: 'left' }}>
      
      {/* DISCORD-STYLE PROFILE POPOVER MODAL */}
      {inspectedUserKey && (
        <div 
          onClick={() => setInspectedUserKey(null)}
          style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.65)', zIndex: 1000, display: 'flex', alignItems: 'center', justifyContent: 'center' }}
        >
          <div 
            onClick={e => e.stopPropagation()}
            style={{ width: 340, background: '#1e1e24', borderRadius: 12, padding: 20, border: '1px solid #444', boxShadow: '0 12px 32px rgba(0,0,0,0.6)' }}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: 14, marginBottom: 14 }}>
              {inspectedProfile?.avatar ? (
                <img src={inspectedProfile.avatar} alt="" style={{ width: 64, height: 64, borderRadius: '50%', objectFit: 'cover', border: '3px solid #646cff' }} />
              ) : (
                <div style={{ width: 64, height: 64, borderRadius: '50%', background: '#333' }} />
              )}
              <div>
                <h3 style={{ margin: 0, display: 'flex', alignItems: 'center', gap: 6 }}>
                  {inspectedProfile?.username || 'Unknown'}
                  {serverConfig?.admins?.includes(inspectedUserKey) && <span title="Server Admin / Operator">👑</span>}
                </h3>
                <div style={{ fontSize: 11, color: '#888', marginTop: 2 }}>
                  ID: <code>{inspectedUserKey.slice(0, 14)}...</code>
                </div>
                {/* Anti-Impersonation Verification Badge */}
                {inspectedUserKey !== identity.publicKeyHex && (
                  <div style={{ fontSize: 11, marginTop: 4, color: friends.includes(inspectedUserKey) ? '#4caf50' : '#ffb74d' }}>
                    {friends.includes(inspectedUserKey) ? '✅ Verified Friend' : '⚠️ Not in your Friends List'}
                  </div>
                )}
              </div>
            </div>

            {inspectedProfile?.bio && (
              <div style={{ background: '#141418', padding: 10, borderRadius: 6, fontSize: 12, color: '#ccc', marginBottom: 12 }}>
                "{inspectedProfile.bio}"
              </div>
            )}

            {/* Server Badges & Anti-Impersonation Join Date */}
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 14 }}>
              {inspectedProfile?.joinedAt && (
                <span style={{ background: '#2a2a35', padding: '4px 8px', borderRadius: 4, fontSize: 11, color: '#aaa' }}>
                  📅 Joined {new Date(inspectedProfile.joinedAt).toLocaleDateString()}
                </span>
              )}
              {(serverStats.serverStreaks?.[inspectedUserKey]?.count || 0) > 0 && (
                <span style={{ background: '#2a2a35', padding: '4px 8px', borderRadius: 4, fontSize: 11, color: '#ffd54f' }}>
                  🏅 {serverStats.serverStreaks[inspectedUserKey].count}d Server Active Badge
                </span>
              )}
              {getDmStreak(inspectedUserKey) > 0 && (
                <span style={{ background: '#2a2a35', padding: '4px 8px', borderRadius: 4, fontSize: 11, color: '#ff8a65' }}>
                  🔥 {getDmStreak(inspectedUserKey)}d DM Streak
                </span>
              )}
            </div>

            {/* Mutual Friends List */}
            {inspectedUserKey !== identity.publicKeyHex && (
              <div style={{ borderTop: '1px solid #333', paddingTop: 10, marginBottom: 14 }}>
                <div style={{ fontSize: 11, color: '#888', marginBottom: 6, textTransform: 'uppercase' }}>
                  👥 Mutual Friends ({mutualFriends.length})
                </div>
                {mutualFriends.length === 0 ? (
                  <div style={{ fontSize: 12, color: '#666' }}>No mutual friends yet</div>
                ) : (
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                    {mutualFriends.map(mfKey => (
                      <span key={mfKey} style={{ background: '#2a2a35', padding: '3px 8px', borderRadius: 12, fontSize: 11 }}>
                        {serverProfiles[mfKey]?.username || dmProfiles[mfKey]?.username || mfKey.slice(0, 8)}
                      </span>
                    ))}
                  </div>
                )}
              </div>
            )}

            {/* Action Buttons */}
            <div style={{ display: 'flex', gap: 8 }}>
              {inspectedUserKey !== identity.publicKeyHex && (
                <>
                  <button
                    onClick={() => toggleFriend(inspectedUserKey)}
                    style={{ flex: 1, padding: '8px', fontSize: 12, cursor: 'pointer', background: friends.includes(inspectedUserKey) ? '#444' : '#43a047', color: '#fff', border: 'none', borderRadius: 6 }}
                  >
                    {friends.includes(inspectedUserKey) ? '✓ Friends (Remove)' : '➕ Add Friend'}
                  </button>
                  <button
                    onClick={() => openDirectMessage(inspectedUserKey)}
                    style={{ flex: 1, padding: '8px', fontSize: 12, cursor: 'pointer', background: '#646cff', color: '#fff', border: 'none', borderRadius: 6 }}
                  >
                    💬 Message
                  </button>
                </>
              )}
              <button
                onClick={() => setInspectedUserKey(null)}
                style={{ padding: '8px 12px', fontSize: 12, cursor: 'pointer', background: '#333', color: '#ccc', border: 'none', borderRadius: 6 }}
              >
                Close
              </button>
            </div>
          </div>
        </div>
      )}

      {/* LEFT SIDEBAR (Fixed flexShrink: 0 so it never squishes!) */}
      <div style={{ width: 270, flexShrink: 0, borderRight: '1px solid #333', padding: 14, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 12 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <h3 style={{ margin: 0 }}>My Account</h3>
          <button onClick={handleLogout} style={{ padding: '4px 10px', fontSize: 12 }}>Log Out</button>
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <label style={{ cursor: 'pointer', flexShrink: 0 }} title="Click to change avatar">
            {avatar ? (
              <img src={avatar} alt="avatar" style={{ width: 48, height: 48, borderRadius: '50%', objectFit: 'cover', border: '2px solid #646cff' }} />
            ) : (
              <div style={{ width: 48, height: 48, borderRadius: '50%', background: '#333', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 11, color: '#aaa', border: '1px dashed #666' }}>
                + Photo
              </div>
            )}
            <input type="file" accept="image/*" onChange={handleAvatarUpload} style={{ display: 'none' }} />
          </label>
          <div style={{ fontSize: 11, color: '#aaa', flex: 1, overflow: 'hidden' }}>
            <div style={{ marginBottom: 4 }}><strong>Public ID:</strong></div>
            <div style={{ display: 'flex', gap: 4 }}>
              <input
                readOnly
                value={identity.publicKeyHex}
                onFocus={e => e.target.select()}
                style={{ width: '100%', fontSize: 10, padding: '4px', background: '#1a1a1a', color: '#eee', border: '1px solid #444', borderRadius: 4 }}
              />
              <button
                onClick={() => copyToClipboard(identity.publicKeyHex)}
                style={{ padding: '4px 6px', fontSize: 10, cursor: 'pointer', background: copiedId ? '#43a047' : '#646cff', color: '#fff', border: 'none', borderRadius: 4 }}
              >
                {copiedId ? '✓' : 'Copy'}
              </button>
            </div>
          </div>
        </div>

        <details style={{ fontSize: 11 }}>
          <summary style={{ cursor: 'pointer' }}>Recovery Phrase & Cloud Backup</summary>
          <code style={{ display: 'block', padding: 8, background: '#222', color: '#eee', borderRadius: 4, marginTop: 6 }}>
            {identity.mnemonic}
          </code>
          {activeServerUrl && serverConfig?.allowSnapshots && (
            <label style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 8, cursor: 'pointer' }}>
              <input
                type="checkbox"
                checked={snapshotServers.includes(activeServerUrl)}
                onChange={() => toggleServerSnapshot(activeServerUrl)}
              />
              <span>☁️ Backup encrypted profile to {serverName}</span>
            </label>
          )}
        </details>

        <label style={{ fontSize: 12 }}>
          <strong>Username:</strong>
          <input 
            value={username} 
            onChange={e => profileMap.set('username', e.target.value)} 
            style={{ width: '100%', marginTop: 4, padding: 6, boxSizing: 'border-box' }}
          />
        </label>

        <label style={{ fontSize: 12 }}>
          <strong>Bio:</strong>
          <textarea 
            rows={2}
            value={bio} 
            onChange={e => profileMap.set('bio', e.target.value)} 
            style={{ width: '100%', marginTop: 4, padding: 6, boxSizing: 'border-box' }}
          />
        </label>

        <hr style={{ width: '100%', opacity: 0.2 }} />

        {/* SERVERS SECTION */}
        <h4 style={{ margin: 0 }}>Community Servers</h4>
        <div style={{ display: 'flex', gap: 6 }}>
          <input 
            value={newServerUrl} 
            onChange={e => setNewServerUrl(e.target.value)} 
            placeholder="ws://localhost:8080" 
            style={{ flex: 1, padding: 6, fontSize: 12 }}
          />
          <button onClick={() => {
            if (newServerUrl.trim() && !serversArray.toArray().includes(newServerUrl.trim())) {
              serversArray.push([newServerUrl.trim()]);
            }
          }}>
            Add
          </button>
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          {servers.map((url, idx) => {
            const isSelected = (viewMode === 'server' || viewMode === 'admin') && activeServerUrl === url;
            return (
              <div 
                key={idx} 
                onClick={() => connectToServer(url)}
                style={{ 
                  padding: '8px 10px', 
                  borderRadius: 6, 
                  cursor: 'pointer',
                  background: isSelected ? '#646cff' : '#2a2a2a',
                  color: '#fff',
                  fontSize: 12,
                  display: 'flex',
                  justifyContent: 'space-between',
                  alignItems: 'center'
                }}
              >
                <span style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>{url}</span>
                <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                  <span style={{ fontSize: 10, opacity: 0.8 }}>
                    {activeServerUrl === url && connStatus === 'connected' ? '●' : 'Join'}
                  </span>
                  <span onClick={(e) => removeServer(idx, e)} style={{ fontSize: 14, opacity: 0.6, padding: '0 4px' }}>×</span>
                </div>
              </div>
            );
          })}
        </div>

        <hr style={{ width: '100%', opacity: 0.2 }} />

        {/* INCOMING FRIEND / DM REQUESTS */}
        {incomingRequests.length > 0 && (
          <div style={{ background: '#2c221e', padding: 10, borderRadius: 6, border: '1px solid #ff9800' }}>
            <div style={{ fontSize: 12, fontWeight: 'bold', color: '#ffb74d', marginBottom: 6 }}>
              🔔 Friend & DM Requests ({incomingRequests.length})
            </div>
            {incomingRequests.map(reqKey => {
              const p = serverProfiles[reqKey];
              return (
                <div key={reqKey} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', fontSize: 12, marginBottom: 4 }}>
                  <span onClick={() => setInspectedUserKey(reqKey)} style={{ cursor: 'pointer', textDecoration: 'underline' }}>
                    {p?.username || `${reqKey.slice(0, 10)}...`}
                  </span>
                  <div style={{ display: 'flex', gap: 4 }}>
                    <button onClick={() => openDirectMessage(reqKey)} style={{ fontSize: 10, padding: '2px 6px', background: '#43a047', color: '#fff', border: 'none', borderRadius: 3 }}>Accept</button>
                    <button onClick={() => toggleBlockUser(reqKey)} style={{ fontSize: 10, padding: '2px 6px', background: '#e53935', color: '#fff', border: 'none', borderRadius: 3 }}>Block</button>
                  </div>
                </div>
              );
            })}
          </div>
        )}

        {/* FRIENDS LIST (With DM Streaks & Mutual Friends!) */}
        <h4 style={{ margin: 0 }}>Friends ({friends.length})</h4>
        <div style={{ fontSize: 11, color: '#888' }}>
          Click any user in a server to view their Profile Card & add them!
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          {friends.map((fKey, idx) => {
            const knownProfile = serverProfiles[fKey] || dmProfiles[fKey];
            const isSelected = viewMode === 'dm' && activeFriendKey === fKey;
            const dmStreak = getDmStreak(fKey);
            return (
              <div
                key={fKey}
                onClick={() => openDirectMessage(fKey)}
                style={{
                  padding: '6px 10px',
                  borderRadius: 6,
                  cursor: 'pointer',
                  background: isSelected ? '#646cff' : '#2a2a2a',
                  fontSize: 12,
                  display: 'flex',
                  justifyContent: 'space-between',
                  alignItems: 'center'
                }}
              >
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  {knownProfile?.avatar ? (
                    <img src={knownProfile.avatar} alt="" style={{ width: 22, height: 22, borderRadius: '50%', objectFit: 'cover' }} />
                  ) : (
                    <div style={{ width: 22, height: 22, borderRadius: '50%', background: '#444' }} />
                  )}
                  <span>{knownProfile?.username || `${fKey.slice(0, 10)}...`}</span>
                  {dmStreak > 0 && <span title="Daily DM Streak" style={{ color: '#ff8a65', fontWeight: 'bold' }}>🔥{dmStreak}</span>}
                </div>
                <span onClick={(e) => removeFriend(idx, e)} style={{ fontSize: 14, opacity: 0.6, padding: '0 4px' }}>×</span>
              </div>
            );
          })}
        </div>
      </div>

      {/* MAIN AREA */}
      <div style={{ flex: 1, display: 'flex', overflow: 'hidden' }}>
        {viewMode === 'dm' && activeFriendKey ? (
          // DIRECT MESSAGE VIEW (With Daily DM Streak Counter!)
          <div style={{ flex: 1, display: 'flex', flexDirection: 'column', padding: 20 }}>
            <div style={{ borderBottom: '1px solid #333', paddingBottom: 10, marginBottom: 12, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                <h3 
                  onClick={() => setInspectedUserKey(activeFriendKey)}
                  style={{ margin: 0, cursor: 'pointer' }}
                  title="Click to view Profile Card"
                >
                  {dmProfiles[activeFriendKey]?.username || serverProfiles[activeFriendKey]?.username || `${activeFriendKey.slice(0, 12)}...`}
                </h3>
                {getDmStreak(activeFriendKey) > 0 && (
                  <span style={{ background: '#3e2723', color: '#ff8a65', padding: '3px 8px', borderRadius: 12, fontSize: 12, fontWeight: 'bold' }}>
                    🔥 {getDmStreak(activeFriendKey)} Day Streak
                  </span>
                )}
              </div>
              <div style={{ display: 'flex', gap: 8 }}>
                <button
                  onClick={() => setInspectedUserKey(activeFriendKey)}
                  style={{ padding: '4px 10px', fontSize: 11, background: '#333', color: '#fff', border: 'none', borderRadius: 4, cursor: 'pointer' }}
                >
                  👤 View Profile
                </button>
                <button 
                  onClick={() => toggleBlockUser(activeFriendKey)}
                  style={{ padding: '4px 10px', fontSize: 11, background: blocked.includes(activeFriendKey) ? '#43a047' : '#e53935', color: '#fff', border: 'none', borderRadius: 4, cursor: 'pointer' }}
                >
                  {blocked.includes(activeFriendKey) ? 'Unblock' : '🚫 Block'}
                </button>
              </div>
            </div>

            <div style={{ flex: 1, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 10 }}>
              {combinedDmMessages.map(msg => {
                const isMine = msg.senderKey === identity.publicKeyHex;
                const p = isMine 
                  ? { username, avatar } 
                  : (dmProfiles[msg.senderKey] || serverProfiles[msg.senderKey]);

                return (
                  <div key={msg.id} style={{ display: 'flex', justifyContent: 'space-between', background: '#222', padding: '8px 12px', borderRadius: 6, alignItems: 'flex-start' }}>
                    <div style={{ display: 'flex', gap: 10 }}>
                      {p?.avatar ? (
                        <img onClick={() => setInspectedUserKey(msg.senderKey)} src={p.avatar} alt="" style={{ width: 34, height: 34, borderRadius: '50%', objectFit: 'cover', cursor: 'pointer' }} />
                      ) : (
                        <div onClick={() => setInspectedUserKey(msg.senderKey)} style={{ width: 34, height: 34, borderRadius: '50%', background: '#444', cursor: 'pointer' }} />
                      )}
                      <div>
                        <div style={{ fontSize: 12, color: '#4caf50', fontWeight: 'bold' }}>
                          <span onClick={() => setInspectedUserKey(msg.senderKey)} style={{ cursor: 'pointer' }}>
                            {p?.username || 'Friend'}
                          </span>{' '}
                          <span style={{ color: '#666', fontWeight: 'normal', fontSize: 11 }}>
                            {formatTime(msg.timestamp)}
                          </span>
                        </div>
                        {renderMessageContent(msg.text)}
                      </div>
                    </div>
                    {isMine && (
                      <button onClick={() => deleteMessage(msg.id)} style={{ background: 'none', border: 'none', color: '#888', cursor: 'pointer', fontSize: 13 }}>
                        🗑️
                      </button>
                    )}
                  </div>
                );
              })}
              <div ref={chatBottomRef} />
            </div>

            <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
              <label style={{ padding: '10px 12px', background: '#333', borderRadius: 6, cursor: 'pointer' }}>
                📷
                <input type="file" accept="image/*" onChange={e => e.target.files?.[0] && handleChatImageUpload(e.target.files[0])} style={{ display: 'none' }} />
              </label>
              <input
                value={chatInput}
                onChange={e => setChatInput(e.target.value)}
                onKeyDown={e => e.key === 'Enter' && sendChatMessage()}
                onPaste={e => {
                  const file = e.clipboardData.files?.[0];
                  if (file && file.type.startsWith('image/')) handleChatImageUpload(file);
                }}
                placeholder="Send DM to keep your daily streak alive..."
                style={{ flex: 1, padding: 10, borderRadius: 6, border: '1px solid #444' }}
              />
              <button onClick={sendChatMessage} style={{ padding: '10px 18px' }}>Send</button>
            </div>
          </div>
        ) : !activeServerUrl ? (
          <div style={{ margin: 'auto', textAlign: 'center', color: '#888' }}>
            <h3>Select a Server</h3>
            <p>Click a community server on the left to join!</p>
          </div>
        ) : (
          <>
            {/* SERVER CHANNELS, VOICE & ADMIN BUTTON SIDEBAR */}
            <div style={{ width: 200, flexShrink: 0, borderRight: '1px solid #333', padding: 16, background: '#1a1a1a', display: 'flex', flexDirection: 'column', gap: 14, overflowY: 'auto' }}>
              <div>
                <h4 style={{ margin: '0 0 4px 0', fontSize: 14 }}>{serverName}</h4>
                <div style={{ fontSize: 11, marginBottom: 8, color: connStatus === 'connected' ? '#4caf50' : '#ff9800' }}>
                  ● {connStatus.toUpperCase()} {isMeAdmin && '• 👑 ADMIN'}
                </div>

                {/* ALL-IN-ONE SERVER ADMIN PAGE BUTTON (Visible to Server Operators!) */}
                {isMeAdmin && (
                  <button
                    onClick={() => setViewMode(viewMode === 'admin' ? 'server' : 'admin')}
                    style={{
                      width: '100%',
                      padding: '7px',
                      marginBottom: 10,
                      background: viewMode === 'admin' ? '#646cff' : '#2c2c38',
                      color: '#ffd54f',
                      border: '1px solid #ffd54f',
                      borderRadius: 6,
                      fontSize: 12,
                      fontWeight: 'bold',
                      cursor: 'pointer'
                    }}
                  >
                    ⚙️ {viewMode === 'admin' ? 'Back to Chat' : 'Server Admin Panel'}
                  </button>
                )}

                <div style={{ background: '#222', padding: 8, borderRadius: 6, fontSize: 11, color: '#bbb', marginBottom: 12 }}>
                  <div style={{ fontWeight: 'bold', color: '#ffd54f', marginBottom: 4 }}>🏆 Server Highscores</div>
                  <div>👥 Largest Call: <strong>{serverStats.largestVoiceCall}</strong></div>
                  <div>⏱️ Longest Call: <strong>{serverStats.longestVoiceCallSeconds}s</strong></div>
                </div>

                <div style={{ fontSize: 11, color: '#888', marginBottom: 6, textTransform: 'uppercase' }}>Text Channels</div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                  {channels.map(ch => (
                    <div
                      key={ch}
                      onClick={() => {
                        setViewMode('server');
                        setActiveChannel(ch);
                      }}
                      style={{
                        padding: '6px 10px',
                        borderRadius: 4,
                        cursor: 'pointer',
                        fontSize: 13,
                        background: viewMode === 'server' && activeChannel === ch ? '#333' : 'transparent',
                        color: viewMode === 'server' && activeChannel === ch ? '#fff' : '#888',
                        fontWeight: viewMode === 'server' && activeChannel === ch ? 'bold' : 'normal'
                      }}
                    >
                      # {ch}
                    </div>
                  ))}
                </div>
              </div>

              {/* VOICE CHANNEL SECTION */}
              <div>
                <div style={{ fontSize: 11, color: '#888', marginBottom: 6, textTransform: 'uppercase' }}>Voice Channels</div>
                <div style={{ background: '#242424', padding: 10, borderRadius: 6 }}>
                  <div style={{ fontSize: 13, fontWeight: 'bold', marginBottom: 8 }}>🔊 Voice Lounge</div>
                  <button 
                    onClick={toggleVoice}
                    style={{ width: '100%', padding: '6px', fontSize: 12, cursor: 'pointer', background: inVoice ? '#e53935' : '#43a047', color: '#fff', border: 'none', borderRadius: 4, marginBottom: 8 }}
                  >
                    {inVoice ? 'Disconnect' : 'Join Voice'}
                  </button>

                  {inVoice && (
                    <div style={{ display: 'flex', gap: 6, marginBottom: 10 }}>
                      <button onClick={toggleMute} style={{ flex: 1, padding: '5px', fontSize: 11, cursor: 'pointer', background: isMuted ? '#e53935' : '#333', color: '#fff', border: 'none', borderRadius: 4 }}>
                        {isMuted ? '🔇 Muted' : '🎤 Mute'}
                      </button>
                      <button onClick={toggleDeafen} style={{ flex: 1, padding: '5px', fontSize: 11, cursor: 'pointer', background: isDeafened ? '#e53935' : '#333', color: '#fff', border: 'none', borderRadius: 4 }}>
                        {isDeafened ? '🙉 Deaf' : '🎧 Deafen'}
                      </button>
                    </div>
                  )}

                  <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                    {voiceUsers.map(vKey => {
                      const vp = serverProfiles[vKey];
                      return (
                        <div key={vKey} onClick={() => setInspectedUserKey(vKey)} style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, cursor: 'pointer' }}>
                          {vp?.avatar ? (
                            <img src={vp.avatar} alt="" style={{ width: 22, height: 22, borderRadius: '50%', border: '2px solid #4caf50', objectFit: 'cover' }} />
                          ) : (
                            <div style={{ width: 22, height: 22, borderRadius: '50%', background: '#4caf50' }} />
                          )}
                          <span>{vp?.username || vKey.slice(0, 8)}</span>
                        </div>
                      );
                    })}
                  </div>
                </div>
              </div>
            </div>

            {/* CENTER COLUMN: Either Built-In Server Admin Page OR Chat Messages */}
            {viewMode === 'admin' && isMeAdmin && serverConfig ? (
              <div style={{ flex: 1, padding: 24, overflowY: 'auto' }}>
                <h2>⚙️ Server Administration ({serverConfig.serverName})</h2>
                <p style={{ color: '#aaa', fontSize: 13 }}>
                  Manage server settings, channels, encrypted snapshot backups, and bans directly inside the client.
                </p>

                <div style={{ display: 'flex', flexDirection: 'column', gap: 20, maxWidth: 520, marginTop: 20 }}>
                  {/* Server Name */}
                  <div style={{ background: '#222', padding: 16, borderRadius: 8 }}>
                    <h4 style={{ marginTop: 0 }}>Server Name</h4>
                    <div style={{ display: 'flex', gap: 8 }}>
                      <input
                        defaultValue={serverConfig.serverName}
                        onBlur={e => sendAdminAction({ action: 'SET_SERVER_NAME', serverName: e.target.value })}
                        style={{ flex: 1, padding: 8 }}
                      />
                      <button style={{ padding: '8px 14px' }}>Save</button>
                    </div>
                  </div>

                  {/* Server Feature Toggles */}
                  <div style={{ background: '#222', padding: 16, borderRadius: 8, display: 'flex', flexDirection: 'column', gap: 12 }}>
                    <h4 style={{ margin: 0 }}>Privacy & Storage Policies</h4>
                    <label style={{ display: 'flex', alignItems: 'center', gap: 10, cursor: 'pointer', fontSize: 13 }}>
                      <input
                        type="checkbox"
                        checked={serverConfig.allowSnapshots}
                        onChange={() => sendAdminAction({ action: 'TOGGLE_SNAPSHOTS' })}
                      />
                      <span><strong>Allow Encrypted Profile Snapshots:</strong> Let members store their AES-encrypted profile backup on this server for offline multi-device sync.</span>
                    </label>
                    <label style={{ display: 'flex', alignItems: 'center', gap: 10, cursor: 'pointer', fontSize: 13 }}>
                      <input
                        type="checkbox"
                        checked={serverConfig.whitelistEnabled}
                        onChange={() => sendAdminAction({ action: 'TOGGLE_WHITELIST' })}
                      />
                      <span><strong>Enable Server Whitelist:</strong> Only whitelisted Public IDs and Admins can connect.</span>
                    </label>
                  </div>

                  {/* Manage Channels */}
                  <div style={{ background: '#222', padding: 16, borderRadius: 8 }}>
                    <h4 style={{ marginTop: 0 }}>Manage Channels</h4>
                    <div style={{ display: 'flex', gap: 8, marginBottom: 12 }}>
                      <input
                        value={newChannelInput}
                        onChange={e => setNewChannelInput(e.target.value)}
                        placeholder="new-channel-name"
                        style={{ flex: 1, padding: 8 }}
                      />
                      <button onClick={() => {
                        if (newChannelInput.trim()) {
                          sendAdminAction({ action: 'ADD_CHANNEL', channel: newChannelInput });
                          setNewChannelInput('');
                        }
                      }}>
                        + Add Channel
                      </button>
                    </div>
                    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
                      {serverConfig.channels.map(ch => (
                        <span key={ch} style={{ background: '#333', padding: '6px 10px', borderRadius: 6, fontSize: 12, display: 'flex', alignItems: 'center', gap: 8 }}>
                          #{ch}
                          <button onClick={() => sendAdminAction({ action: 'REMOVE_CHANNEL', channel: ch })} style={{ background: 'none', border: 'none', color: '#ff5252', cursor: 'pointer' }}>×</button>
                        </span>
                      ))}
                    </div>
                  </div>

                  {/* Promote Operator / Admin */}
                  <div style={{ background: '#222', padding: 16, borderRadius: 8 }}>
                    <h4 style={{ marginTop: 0 }}>👑 Server Operators (Admins)</h4>
                    <div style={{ display: 'flex', gap: 8, marginBottom: 10 }}>
                      <input
                        value={newAdminInput}
                        onChange={e => setNewAdminInput(e.target.value)}
                        placeholder="Paste user Public ID to OP..."
                        style={{ flex: 1, padding: 8 }}
                      />
                      <button onClick={() => {
                        if (newAdminInput.trim()) {
                          sendAdminAction({ action: 'ADD_ADMIN', targetKey: newAdminInput.trim() });
                          setNewAdminInput('');
                        }
                      }}>
                        Grant OP
                      </button>
                    </div>
                    <div style={{ fontSize: 12, color: '#aaa' }}>
                      Current Admins: {serverConfig.admins.map(a => serverProfiles[a]?.username || a.slice(0, 10)).join(', ')}
                    </div>
                  </div>
                </div>
              </div>
            ) : (
              // STANDARD SERVER CHAT COLUMN
              <div style={{ flex: 1, display: 'flex', flexDirection: 'column', padding: 20 }}>
                <div style={{ borderBottom: '1px solid #333', paddingBottom: 10, marginBottom: 12 }}>
                  <h3 style={{ margin: 0 }}># {activeChannel}</h3>
                </div>

                <div style={{ flex: 1, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 10 }}>
                  {channelMessages.map(msg => {
                    const isMine = msg.senderKey === identity.publicKeyHex;
                    const liveProfile = serverProfiles[msg.senderKey];
                    const displayAvatar = liveProfile?.avatar || msg.senderAvatar;
                    const displayName = liveProfile?.username || msg.senderName;
                    const isSenderAdmin = serverConfig?.admins?.includes(msg.senderKey);

                    return (
                      <div key={msg.id} style={{ display: 'flex', justifyContent: 'space-between', background: '#222', padding: '8px 12px', borderRadius: 6, alignItems: 'flex-start' }}>
                        <div style={{ display: 'flex', gap: 10 }}>
                          {displayAvatar ? (
                            <img onClick={() => setInspectedUserKey(msg.senderKey)} src={displayAvatar} alt="" style={{ width: 36, height: 36, borderRadius: '50%', objectFit: 'cover', cursor: 'pointer' }} />
                          ) : (
                            <div onClick={() => setInspectedUserKey(msg.senderKey)} style={{ width: 36, height: 36, borderRadius: '50%', background: '#444', cursor: 'pointer' }} />
                          )}
                          <div>
                            <div style={{ fontSize: 12, color: '#646cff', fontWeight: 'bold', display: 'flex', alignItems: 'center', gap: 6 }}>
                              <span onClick={() => setInspectedUserKey(msg.senderKey)} style={{ cursor: 'pointer' }}>
                                {displayName}
                              </span>
                              {isSenderAdmin && <span title="Server Admin">👑</span>}
                              <span style={{ color: '#666', fontWeight: 'normal', fontSize: 11 }}>
                                • {formatTime(msg.timestamp)}
                              </span>
                            </div>
                            {renderMessageContent(msg.text)}
                          </div>
                        </div>
                        {(isMine || isMeAdmin) && (
                          <button onClick={() => deleteMessage(msg.id)} title="Delete message" style={{ background: 'none', border: 'none', color: '#888', cursor: 'pointer', fontSize: 13 }}>
                            🗑️
                          </button>
                        )}
                      </div>
                    );
                  })}
                  <div ref={chatBottomRef} />
                </div>

                <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
                  <label style={{ padding: '10px 12px', background: '#333', borderRadius: 6, cursor: 'pointer' }} title="Upload Image">
                    📷
                    <input type="file" accept="image/*" onChange={e => e.target.files?.[0] && handleChatImageUpload(e.target.files[0])} style={{ display: 'none' }} />
                  </label>
                  <input
                    value={chatInput}
                    onChange={e => setChatInput(e.target.value)}
                    onKeyDown={e => e.key === 'Enter' && sendChatMessage()}
                    onPaste={e => {
                      const file = e.clipboardData.files?.[0];
                      if (file && file.type.startsWith('image/')) handleChatImageUpload(file);
                    }}
                    placeholder={`Message #${activeChannel} (paste image or .gif URL)...`}
                    style={{ flex: 1, padding: 10, borderRadius: 6, border: '1px solid #444' }}
                  />
                  <button onClick={sendChatMessage} style={{ padding: '10px 18px' }}>
                    Send
                  </button>
                </div>
              </div>
            )}

            {/* RIGHT SIDEBAR: Server Member List (Click any user to open their Discord-Style Profile Card!) */}
            <div style={{ width: 220, flexShrink: 0, borderLeft: '1px solid #333', padding: 16, overflowY: 'auto' }}>
              <h4 style={{ marginTop: 0 }}>Online Members ({serverUsers.length})</h4>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                {serverUsers.map(u => {
                  const isUserAdmin = serverConfig?.admins?.includes(u.publicKey);
                  return (
                    <div 
                      key={u.publicKey} 
                      onClick={() => setInspectedUserKey(u.publicKey)}
                      title="Click to open Profile Card"
                      style={{ display: 'flex', gap: 10, alignItems: 'center', padding: 8, background: '#222', borderRadius: 6, cursor: 'pointer' }}
                    >
                      {u.avatar ? (
                        <img src={u.avatar} alt="" style={{ width: 34, height: 34, borderRadius: '50%', objectFit: 'cover' }} />
                      ) : (
                        <div style={{ width: 34, height: 34, borderRadius: '50%', background: '#444', flexShrink: 0 }} />
                      )}
                      <div style={{ overflow: 'hidden' }}>
                        <div style={{ fontWeight: 'bold', fontSize: 13, display: 'flex', alignItems: 'center', gap: 4 }}>
                          <span>{u.username}</span>
                          {isUserAdmin && <span>👑</span>}
                        </div>
                        {u.bio && <div style={{ fontSize: 11, color: '#bbb', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{u.bio}</div>}
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          </>
        )}
      </div>

    </div>
  );
}
