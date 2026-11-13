# Chap - Decentralized P2P Chat App

A peer-to-peer WebSocket chat application that stores identity and message data on your local device. No central server, no email addresses, no phone numbers—your account lives entirely on your devices.

## Overview

**Client (React/TypeScript):** Browser-based UI with local CRDT storage for profiles and messages. Identity is generated using Bip39 mnemonic + Ed25519 cryptography.

**Server (Node.js/WS):** Lightweight WebSocket server that broadcasts state to all connected clients, handles authentication challenges, and stores snapshots/messages locally. Self-hostable community servers.

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│  CLIENT                              │                         │
│  ┌──────────────────────────────────┐                        │
│  │ Local Identity (Bip39 + Ed25519)  │                        │
│  │ - Generate new account locally   │                        │
│  │ - Import from mnemonic           │                        │
│  └──────────┬────────────────────────┘                        │
│             │ encrypts data via AES-GCM                         │
│  ┌─────────▼───────────────────────┐                          │
│  │ Local CRDT (Yjs + IndexedDB)     │                          │
│  │ - Profile state                  │                          │
│  │ - Message history                │                          │
│  │ - Encrypted snapshots           │                          │
│  └──────────┬──────────────────────┘                          │
│             │ publishes encrypted backup                        │
│  ┌─────────▼───────────────────────┐                          │
│  │   WebSocket Client              │                          │
│  │ - Auth: Sign challenge locally  │                          │
│  │ - Join/leave voice calls         │                          │
│  │ - P2P DM sessions               │                          │
│  └─────────────────────────────────┘                          │
└──────────────┬────────────────────────────────────────────────┘
               │
               ↓ encrypted snapshots to server (if enabled)
┌──────────────▼────────────────────────────────────────────────┐
│              SERVER (WebSocket Server - Node.js)               │
│  ┌─────────────────────────────────────────────────────────┐  │
│  │                   Admin Console (terminal)                  │  │
│  │   Commands: op <publicKey> | deop <publicKey> | snapshots│  │
│  └─────────────────────────────────────────────────────────┘  │
│                                                                  │
│  WebSocket Protocol:                                             │
│  - AUTH_CHALLENGE: Server sends 32-byte random hex              │
│  - AUTH_RESPONSE: Client signs challenge, returns public key   │
│  - PROFILE_UPDATE: Client broadcasts profile changes             │
│  - CHAT_MESSAGE: Send messages to server                        │
│  - DIRECT_MESSAGE: Broadcast to peer via P2P tunnel            │
│  - VOICE_JOIN/SIGNAL: Voice call coordination                    │
│  - SAVE_SNAPSHOT: Upload encrypted backup to server             │
│                                                                  │
│  Local Storage (JSON):                                           │
│  - config.json: Server name, channels, admin whitelist        │
│  - messages.json: Chat message history                         │
│  - dms.json: Direct messages                                  │
│  - profiles.json: User profiles per public key                 │
│  - stats.json: Voice call stats, streaks                        │
│  - snapshots.json: Encrypted client backups                   │
└───────────────────────────────────────────────────────────────┘

Key Security Features:
├── Identity Keys: Bip39 mnemonic → Ed25519 public/private key pair stored locally
├── Encryption: AES-GCM encrypts profile snapshots for offline sync
├── Authentication: ECDH/Ed25519 signing for server authentication
├── P2P: WebRTC ICE candidate exchange via WebSocket relay
└── No central database: All data remains on user's device or local server cache
```

## Installation

### Client (Browser)

**Create a new account:**

1. Open [chap-client](file:///home/joshuafc/Projects/chap/chap-client/index.html) in browser
2. Click "Create New Account"
3. Follow the prompts to generate your 12-word mnemonic recovery phrase

**Import existing account:**
1. Enter your 12-word recovery phrase
2. Sync & log in

### Server (Node.js)

```bash
cd ./Projects/chap/chap-server
npm install
# Then run: node server.mjs
```

Or use Docker:
```bash
docker-compose up -d
```

## Usage

### Creating an Account

When you first open the client:
- Generate a new Bip39 mnemonic (12 words) stored in `local_seed_phrase` localStorage
- This generates your Ed25519 public/private key pair
- Public key becomes your identity in the community

### Joining Servers

1. In the client, enter a WebSocket URL in the "Community Servers" section
2. Format: `ws://localhost:8080` or any self-hosted server address
3. Click "Add" and connect to join the server

### Managing Friends & DMs

- Any public key (Ed25519) can be added as a friend
- P2P Direct Messages are established automatically using sorted public keys as room identifier
- Message history is stored locally on both devices via CRDT

### Voice Calls

- Click "Join Voice" in the server sidebar
- WebRTC peer connections are established for each peer
- Audio is routed through the local server relay (not end-to-end)

### Server Administration (Admin Only)

**Access Admin Panel:**
- When connected to a server, an "Admin" badge appears if you are whitelisted or auto-granted as admin
- Click "Server Admin Panel" button in the left sidebar

**Console Commands (type these in terminal):**
```bash
op <publicKey>    # Grant operator/admin to a user
deop <publicKey>   # Remove operator/admin status
snapshots         # Toggle snapshot encryption feature
```

**Admin Actions (via WebSocket):**
- `SET_SERVER_NAME` - Change server name
- `ADD_CHANNEL` - Create text channels
- `REMOVE_CHANNEL` - Delete channels
- `TOGGLE_SNAPSHOTS` - Enable/disable encrypted backups
- `TOGGLE_WHITELIST` - Enable/disable whitelist
- `ADD_ADMIN` - Grant operator status
- `BAN_USER` - Ban users from server

## Data Flow Examples

### Authentication Flow
```
1. Client connects → Server sends AUTH_CHALLENGE (random 32-byte hex)
2. Client signs challenge locally with private key → Sends AUTH_RESPONSE (publicKey, signature)
3. Server verifies signature using ECDH → Broadcasts INIT_STATE to all clients
```

### Message Flow
```
1. Client types message → Sends CHAT_MESSAGE to server
2. Server stores in messages.json → Broadcasts NEW_MESSAGE to all connected clients
3. All clients update local CRDT → Messages appear in UI instantly
```

### P2P DM Flow
```
1. Click user in friend list → Initiates P2PDMSession with sortedPublicKey pair
2. Creates deterministic room name: "chap-p2p-dm-{sortedKeys}"
3. Both devices join same WebSocket signal channel
4. Messages are stored locally on both sides via CRDT
5. Voice calls are established over WebRTC for audio transmission
```

### Encrypted Snapshot Flow
```
1. User enables snapshot backup in profile settings
2. Client encrypts entire CRDT state using AES-GCM (private key derived from Bip39)
3. Sends encryptedHex to server via SAVE_SNAPSHOT
4. Server stores in snapshots.json (encrypted blob, not decrypted)
5. On device change: client decrypts and merges snapshot locally
```

## Commands Reference

### Client Actions
| Action | Type | Description |
|--------|------|-------------|
| Create Account | - | Generate new Bip39 + Ed25519 key pair |
| Import Account | - | Restore identity from 12-word mnemonic |
| Add Friend | - | Add public key to friends list |
| Block User | - | Prevent messages from blocked user |
| Join Voice | - | Start WebRTC voice call |
| Mute/Deafen | - | Audio controls for voice calls |

### Server Commands (Terminal)
```bash
op <publicKey>      # Grant admin/operator status
deop <publicKey>     # Remove admin/operator status
snapshots           # Toggle encrypted snapshot backups (on/off)
```

## Configuration

### Environment Variables (Server)
```env
SERVER_NAME="Your Server Name"   # Server display name
PORT=8080                        # WebSocket port (default)
DATA_DIR=/app/data              # Local data storage directory
```

### Client Settings
- **Identity:** Stored locally in `local_seed_phrase` (localStorage)
- **Servers:** Add multiple community servers with different WebSocket URLs
- **Snapshots:** Enable encrypted profile backups on specific servers for offline sync
- **Profile Updates:** Auto-broadcast to connected servers when you update username/bio/avatar

## Security Model

### Identity & Authentication
- Users generate Ed25519 keys locally (Bip39 mnemonic → seed → private key → public key)
- No server-side user database: All identities are ephemeral per-session
- Server authentication uses challenge-response with ECDH signing

### Privacy Features
- **No central data:** Chat history and profiles stored on client devices via CRDT
- **Encrypted snapshots:** Option to encrypt profile state before upload
- **Blacklist/Whitelist:** Server admins can ban/block specific public keys
- **P2P DMs:** Direct messages use WebRTC for audio, with messages stored locally

### Data Persistence
- **Client:** IndexedDB stores profiles and chat message history
- **Server:** JSON files persist messages/profiles/stats between sessions
- **Snapshots:** Encrypted backups on server allow offline device sync

## Troubleshooting

### Cannot Connect to Server
- Ensure WebSocket URL uses `ws://` (not `https://`)
- Check server is running and accessible: `curl ws://localhost:8080`
- Verify firewall allows port 8080 traffic

### Authentication Errors
- Invalid recovery phrase? Use a fresh mnemonic generation
- Signature rejected? Ensure you're using the private key from your generated identity
- Whitelisted server? Check whitelist enabled in server config

### Voice Call Issues
- Check browser microphone permissions
- Peer needs to be online and have microphone access
- WebRTC ICE servers (stun.l.google.com) should auto-connect

## License

[MIT](LICENSE) (if LICENSE file exists)

## Support

For issues, use the community servers or check:
- Discord/Community forum
- Issue tracker (if available)

---

*Built for decentralized communication where your identity lives on your device.*
