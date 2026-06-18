/**
 * liteparse-history.ts — Recent files history with IndexedDB persistence.
 * Stores: id, name, size, type, addedAt, parsed (markdown/text/json)
 */

const DB_NAME = 'liteparse-history'
const STORE = 'entries'
const MAX_ENTRIES = 20

let dbPromise: Promise<IDBDatabase> | null = null

function openDB(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1)
    req.onupgradeneeded = () => {
      const db = req.result
      if (!db.objectStoreNames.contains(STORE)) {
        const store = db.createObjectStore(STORE, { keyPath: 'id' })
        store.createIndex('addedAt', 'addedAt')
      }
    }
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
  return dbPromise
}

export interface HistoryEntry {
  id: string
  name: string
  size: number
  type: string
  addedAt: number
  // Parsed outputs cached
  markdown: string
  text: string
  json: string
  pageCount: number
  itemCount: number
  // Small thumbnail data URL of first page PNG
  thumbnail?: string
  // Original file bytes (kept for re-render)
  fileBytes: ArrayBuffer
}

export async function saveToHistory(entry: Omit<HistoryEntry, 'id' | 'addedAt'>): Promise<HistoryEntry> {
  const db = await openDB()
  const full: HistoryEntry = {
    ...entry,
    id: crypto.randomUUID(),
    addedAt: Date.now(),
  }
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite')
    tx.objectStore(STORE).put(full)
    tx.oncomplete = () => {
      trimHistory().catch(() => {})
      resolve(full)
    }
    tx.onerror = () => reject(tx.error)
  })
}

export async function listHistory(): Promise<HistoryEntry[]> {
  const db = await openDB()
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readonly')
    const req = tx.objectStore(STORE).getAll()
    req.onsuccess = () => {
      const all = (req.result as HistoryEntry[]).sort((a, b) => b.addedAt - a.addedAt)
      resolve(all)
    }
    req.onerror = () => reject(req.error)
  })
}

export async function getHistoryEntry(id: string): Promise<HistoryEntry | undefined> {
  const db = await openDB()
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readonly')
    const req = tx.objectStore(STORE).get(id)
    req.onsuccess = () => resolve(req.result as HistoryEntry | undefined)
    req.onerror = () => reject(req.error)
  })
}

export async function deleteHistoryEntry(id: string): Promise<void> {
  const db = await openDB()
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite')
    tx.objectStore(STORE).delete(id)
    tx.oncomplete = () => resolve()
    tx.onerror = () => reject(tx.error)
  })
}

export async function clearHistory(): Promise<void> {
  const db = await openDB()
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite')
    tx.objectStore(STORE).clear()
    tx.oncomplete = () => resolve()
    tx.onerror = () => reject(tx.error)
  })
}

async function trimHistory(): Promise<void> {
  const all = await listHistory()
  if (all.length <= MAX_ENTRIES) return
  const toDelete = all.slice(MAX_ENTRIES)
  const db = await openDB()
  const tx = db.transaction(STORE, 'readwrite')
  for (const e of toDelete) tx.objectStore(STORE).delete(e.id)
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve()
    tx.onerror = () => reject(tx.error)
  })
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / (1024 * 1024)).toFixed(1)} MB`
}

export function formatRelativeTime(ts: number): string {
  const diff = Date.now() - ts
  const sec = Math.floor(diff / 1000)
  if (sec < 60) return 'just now'
  const min = Math.floor(sec / 60)
  if (min < 60) return `${min}m ago`
  const hr = Math.floor(min / 60)
  if (hr < 24) return `${hr}h ago`
  const day = Math.floor(hr / 24)
  if (day < 7) return `${day}d ago`
  return new Date(ts).toLocaleDateString()
}
