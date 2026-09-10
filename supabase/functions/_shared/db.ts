import postgres from 'npm:postgres@3.4.7';

export function db() {
  const url = Deno.env.get('SUPABASE_DB_URL');
  if (!url) throw new Error('SUPABASE_DB_URL is not configured');
  return postgres(url, { prepare: false, max: 1 });
}

export async function readVaultSecret(sql: ReturnType<typeof postgres>, name: string) {
  const rows = await sql<{ decrypted_secret: string }[]>`
    select decrypted_secret
    from vault.decrypted_secrets
    where name = ${name}
    limit 1
  `;
  const value = rows[0]?.decrypted_secret;
  if (!value) throw new Error(`Vault secret ${name} is missing`);
  return value;
}
