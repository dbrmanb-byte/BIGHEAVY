// js/supabase-client.js
// Thin wrapper over @supabase/supabase-js loaded from CDN.
// Exposes auth helpers and the raw client for direct queries.

let _client = null;
let _user = null;
const _listeners = new Set();

export function getClient() { return _client; }
export function getUser() { return _user; }

export async function init(supabaseUrl, supabaseKey) {
  if (_client) return _client;
  const { createClient } = await import(
    "https://esm.sh/@supabase/supabase-js@2"
  );
  _client = createClient(supabaseUrl, supabaseKey, {
    auth: {
      autoRefreshToken: true,
      persistSession: true,
      detectSessionInUrl: true,
    },
  });

  // Hydrate from stored session
  const { data } = await _client.auth.getSession();
  if (data?.session?.user) _setUser(data.session.user);

  // Listen for auth changes (login, logout, token refresh)
  _client.auth.onAuthStateChange((_event, session) => {
    _setUser(session?.user || null);
  });

  return _client;
}

function _setUser(u) {
  _user = u;
  _listeners.forEach((fn) => fn(u));
}

/** Register a callback fired on every auth state change. */
export function onAuthChange(fn) {
  _listeners.add(fn);
  return () => _listeners.delete(fn);
}

// ---- auth actions ----

export async function signUp(email, password, displayName) {
  const { data, error } = await _client.auth.signUp({
    email,
    password,
    options: { data: { display_name: displayName || email.split("@")[0] } },
  });
  if (error) throw error;
  return data;
}

export async function signIn(email, password) {
  const { data, error } = await _client.auth.signInWithPassword({
    email,
    password,
  });
  if (error) throw error;
  return data;
}

export async function signInMagicLink(email) {
  const { error } = await _client.auth.signInWithOtp({ email });
  if (error) throw error;
}

export async function signOut() {
  const { error } = await _client.auth.signOut();
  if (error) throw error;
}

export async function getProfile() {
  if (!_user) return null;
  const { data, error } = await _client
    .from("profiles")
    .select("*")
    .eq("id", _user.id)
    .single();
  if (error) throw error;
  return data;
}

export async function updateProfile(fields) {
  if (!_user) return;
  const { error } = await _client
    .from("profiles")
    .update({ ...fields, updated_at: new Date().toISOString() })
    .eq("id", _user.id);
  if (error) throw error;
}
