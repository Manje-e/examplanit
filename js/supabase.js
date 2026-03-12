// ── SUPABASE CLIENT ──
const sb = supabase.createClient(
  'https://beqruaefzhtvdnxawrgh.supabase.co',
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImJlcXJ1YWVmemh0dmRueGF3cmdoIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzMwNTAyNTQsImV4cCI6MjA4ODYyNjI1NH0.iP_V45AT6ROC6b3dAHIhmTK59ArYUIzDmo5rWtLb3AA'
);

async function signInWithGoogle() {
  const { error } = await sb.auth.signInWithOAuth({
    provider: 'google',
    options: { redirectTo: window.location.href }
  });
  if (error) alert('Login failed: ' + error.message);
}

async function signOutUser() {
  await sb.auth.signOut();
  location.reload();
}

async function dbSave(userId, payload) {
  console.log('📤 dbSave called. userId:', userId, 'subjects:', payload.subjects?.length);
  console.log('📤 dbSave payload:', JSON.stringify(payload));
  const { data, error } = await sb.from('user_plans').upsert(
    { ...payload, user_id: userId, updated_at: new Date().toISOString() },
    { onConflict: 'user_id' }
  ).select();
  if (error) { console.error('❌ dbSave SUPABASE ERROR:', JSON.stringify(error)); return false; }
  console.log('✅ dbSave response:', JSON.stringify(data));
  return true;
}

async function dbLoad(userId) {
  console.log('📥 dbLoad: querying for userId:', userId);
  try {
    const session = await sb.auth.getSession();
    console.log('📥 dbLoad: session check:', !!session.data.session);

    const { data, error } = await sb
      .from('user_plans')
      .select('*')
      .eq('user_id', userId)
      .maybeSingle();

    if (error) {
      console.error('❌ dbLoad SUPABASE ERROR:', error.code, error.message, JSON.stringify(error));
      return null;
    }

    if (!data) {
      console.log('📥 dbLoad: no existing plan found — fresh user');
      return null;
    }

    console.log('📥 dbLoad: got data, subjects:', data.subjects?.length ?? 0);
    return data;
  } catch (e) {
    console.error('❌ dbLoad threw exception:', e);
    return null;
  }
}
