// js/ebooks.js
// A reader's book library: what they own, and how to download it.
//
// Ownership lives on the server and is checked there. Nothing in this file is
// a security boundary — it decides what to show, not what to allow. The
// download endpoint re-checks ownership before it signs anything.

import { getClient, getUser, onAuthChange } from "./supabase-client.js";

const DOWNLOAD_FN = "ebook-download";

let _owned = [];                 // slugs the signed-in reader has bought
let _loaded = false;
const _listeners = new Set();

export function owned() { return _owned.slice(); }
export function ownsBook(slug) { return _owned.includes(slug); }
export function count() { return _owned.length; }
export function loaded() { return _loaded; }

export function onLibraryChange(fn) {
  _listeners.add(fn);
  return () => _listeners.delete(fn);
}
function _notify() { _listeners.forEach(fn => fn(owned())); }

/** Reload the library from the server. Safe to call when signed out. */
export async function refreshLibrary() {
  const client = getClient();
  if (!client || !getUser()) {
    _owned = [];
    _loaded = true;
    _notify();
    return _owned;
  }
  try {
    const { data, error } = await client.rpc("my_ebooks");
    if (error) throw error;
    _owned = Array.isArray(data) ? data : [];
  } catch (err) {
    // Leave the previous list alone rather than telling someone who paid that
    // their library is empty because one request failed.
    console.warn("library fetch failed:", err);
  }
  _loaded = true;
  _notify();
  return _owned;
}

onAuthChange(() => { _loaded = false; refreshLibrary(); });

/**
 * Fetch a book as bytes. The server stamps the buyer's identity onto every page
 * before sending, so this is a real request each time rather than a link that
 * can be passed around.
 * Resolves to a Blob, or throws with a message worth showing the reader.
 */
export async function fetchBook(slug) {
  const client = getClient();
  if (!client) throw new Error("Downloads need a connection.");

  const { data: sessionData } = await client.auth.getSession();
  const token = sessionData?.session?.access_token;
  if (!token) throw new Error("Sign in to download your books.");

  // Not functions.invoke: the reply is a PDF, and invoke wants to parse JSON.
  const base = client.functionsUrl
    || (client.supabaseUrl || "").replace(".supabase.co", ".functions.supabase.co");
  const res = await fetch(`${base.replace(/\/$/, "")}/${DOWNLOAD_FN}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ slug }),
  });

  if (!res.ok) {
    // The function replies with a usable sentence; show that, not a status code.
    let detail = "";
    try { detail = (await res.json())?.error || ""; } catch { /* not JSON */ }
    throw new Error(detail || "That download could not be started.");
  }
  return await res.blob();
}

/** Save the book to the reader's device. */
export async function download(slug) {
  const blob = await fetchBook(slug);
  const url = URL.createObjectURL(blob);
  try {
    const a = document.createElement("a");
    a.href = url;
    a.download = `${slug}.pdf`;
    document.body.appendChild(a);
    a.click();
    a.remove();
  } finally {
    // Give the browser a moment to start the save before dropping the blob.
    setTimeout(() => URL.revokeObjectURL(url), 30000);
  }
}
