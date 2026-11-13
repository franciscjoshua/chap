// src/identity.ts
import * as bip39 from '@scure/bip39';
import { wordlist } from '@scure/bip39/wordlists/english.js';
import * as ed from '@noble/ed25519';

export interface UserIdentity {
  mnemonic: string;
  publicKeyHex: string;
  privateKey: Uint8Array;
}

// Helper: Convert Uint8Array bytes -> Hex string
export function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');
}

// Helper: Convert Hex string -> Uint8Array bytes
export function hexToBytes(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}

export async function generateNewIdentity(): Promise<UserIdentity> {
  const mnemonic = bip39.generateMnemonic(wordlist, 128);
  return restoreIdentityFromMnemonic(mnemonic);
}

export async function restoreIdentityFromMnemonic(mnemonic: string): Promise<UserIdentity> {
  if (!bip39.validateMnemonic(mnemonic, wordlist)) {
    throw new Error("Invalid 12-word recovery phrase!");
  }
  const seed = await bip39.mnemonicToSeed(mnemonic);
  const privateKey = seed.slice(0, 32);
  const publicKeyBytes = await ed.getPublicKeyAsync(privateKey);

  return {
    mnemonic,
    publicKeyHex: bytesToHex(publicKeyBytes),
    privateKey
  };
}

// Fixed for @noble/ed25519 v3: convert hex challenge to Uint8Array before signing!
export async function signChallenge(challengeHex: string, privateKey: Uint8Array): Promise<string> {
  const msgBytes = hexToBytes(challengeHex);
  const sigBytes = await ed.signAsync(msgBytes, privateKey);
  return bytesToHex(sigBytes);
}
