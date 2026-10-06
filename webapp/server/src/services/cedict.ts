import fs from "node:fs";
import path from "node:path";

export interface CedictMatch {
  text: string;
  pinyin: string[];
}

interface TrieNode {
  children: Map<string, TrieNode>;
  pinyin?: string[];
}

const ENTRY_RE = /^\s*(\S+)\s+(\S+)\s+\[([^\]]+)\]\s+\//;
const dictionaryCache = new Map<string, CedictDictionary>();

export class CedictDictionary {
  private readonly root: TrieNode = { children: new Map() };

  constructor(entries: Map<string, string[]>) {
    for (const [text, pinyin] of entries) {
      let node = this.root;
      for (const character of text) {
        let child = node.children.get(character);
        if (!child) {
          child = { children: new Map() };
          node.children.set(character, child);
        }
        node = child;
      }
      node.pinyin = [...pinyin];
    }
  }

  /** Longest dictionary match starting at offset (or null). */
  matchAt(text: string, offset: number): CedictMatch | null {
    const matches = this.matchesAt(text, offset);
    return matches.length ? matches[0] : null;
  }

  /** Every dictionary match starting at offset, longest first. */
  matchesAt(text: string, offset: number): CedictMatch[] {
    const matches: CedictMatch[] = [];
    let node = this.root;
    let index = offset;
    let matchedText = "";

    while (index < text.length) {
      const codePoint = text.codePointAt(index);
      if (codePoint === undefined) break;
      const character = String.fromCodePoint(codePoint);
      const child = node.children.get(character);
      if (!child) break;

      matchedText += character;
      index += character.length;
      node = child;
      if (node.pinyin) {
        matches.push({ text: matchedText, pinyin: [...node.pinyin] });
      }
    }

    return matches.reverse();
  }
}

export function parseCedictLine(line: string): CedictMatch | null {
  if (!line.trim() || line.trimStart().startsWith("#")) return null;
  const match = ENTRY_RE.exec(line);
  if (!match) return null;

  const pinyin = match[3].trim().split(/\s+/).filter(Boolean);
  if (!pinyin.length) return null;
  return { text: match[2], pinyin };
}

export function loadCedict(filePath: string): CedictDictionary {
  const absolutePath = path.resolve(filePath);
  const cached = dictionaryCache.get(absolutePath);
  if (cached) return cached;

  const entries = new Map<string, string[]>();
  const content = fs.readFileSync(absolutePath, "utf8");
  for (const line of content.split(/\r?\n/)) {
    const entry = parseCedictLine(line);
    if (entry) entries.set(entry.text, entry.pinyin);
  }

  const dictionary = new CedictDictionary(entries);
  dictionaryCache.set(absolutePath, dictionary);
  return dictionary;
}
