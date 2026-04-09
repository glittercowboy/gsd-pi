import { RpcClient } from '@gsd-build/rpc-client';

const client = new RpcClient({ cwd: process.cwd() });
await client.start();
const { sessionId } = await client.init({ clientId: 'my-app' });
console.log(`Session: ${sessionId}`);

await client.prompt('Create a hello world script');
for await (const event of client.events()) {
  if (event.type === 'execution_complete') break;
  console.log(event.type);
}
await client.shutdown();
