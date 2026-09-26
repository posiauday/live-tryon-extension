// Checks a Decart API key without opening the extension. Creating a token does not start (or bill) a session.
//   PowerShell:  $env:DECART_API_KEY = "dct_..."; npm run check:decart
//   bash:        DECART_API_KEY=dct_... npm run check:decart
// The key is read from the environment only, never stored, and never printed.
(async () => {
  const apiKey = process.env.DECART_API_KEY;
  if (!apiKey) {
    console.error('Set DECART_API_KEY first (see the comment at the top of this file).');
    process.exit(2);
  }
  const { createDecartClient, models } = await import('@decartai/sdk');
  const model = models.realtime('lucy-vton-latest');
  console.log(`Model: ${model.name}  ${model.width}x${model.height}  ${JSON.stringify(model.fps)} fps`);

  const client = createDecartClient({ apiKey });
  // the same request the extension makes before every AI session
  const options = { expiresIn: 300, allowedModels: ['lucy-vton-latest'], constraints: { realtime: { maxSessionDuration: 60 } } };
  try {
    const token = await client.tokens.create(options);
    console.log('OK: key accepted, short-lived client token created.');
    console.log(`  token expires: ${token.expiresAt}`);
    console.log(`  model limit enforced by Decart: ${JSON.stringify(token.permissions && token.permissions.models)}`);
    console.log(`  session limit enforced by Decart: ${JSON.stringify(token.constraints && token.constraints.realtime)}`);
    if (!token.constraints || !token.constraints.realtime) console.log('  NOTE: no server-side session limit was echoed back. The extension\'s own timer still ends sessions at the limit.');
  } catch (error) {
    console.error(`FAILED: ${error.message || error}`);
    if (error.status) console.error(`  HTTP status: ${error.status}`);
    process.exit(1);
  }
})();
