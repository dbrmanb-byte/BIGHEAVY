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
 * Ask for a time-limited download link for a book.
 * Resolves to a URL, or throws with a message worth showing the reader.
 */
export async function downloadUrl(slug) {
  const client = getClient();
  if (!client) throw new Error("Downloads need a connection.");

  const { data: sessionData } = await client.auth.getSession();
  const token = sessionData?.session?.access_token;
  if (!token) throw new Error("Sign in to download your books.");

  const { data, error } = await client.functions.invoke(DOWNLOAD_FN, {
    body: { slug },
    headers: { Authorization: `Bearer ${token}` },
  });

  if (error) {
    // The function replies with a usable sentence; prefer it over the generic
    // "Edge Function returned a non-2xx status code".
    let detail = "";
    try { detail = (await error.context?.json())?.error || ""; } catch { /* ignore */ }
    throw new Error(detail || "That download could not be started.");
  }
  if (!data?.url) throw new Error("That download could not be started.");
  return data.url;
}

/** Start the download in the browser. */
export async function download(slug) {
  const url = await downloadUrl(slug);
  // Not a new tab: the signed URL is served as an attachment, so a same-tab
  // navigation downloads without leaving the page or tripping a popup blocker.
  window.location.assign(url);
}
