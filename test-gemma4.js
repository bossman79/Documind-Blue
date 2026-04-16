import http from 'http';

const data = JSON.stringify({
  model: 'ollama_cloud/gemma4:31b-cloud',
  messages: [{ role: 'user', content: 'Say OK' }],
  max_tokens: 10
});

const options = {
  hostname: 'localhost',
  port: 8000,
  path: '/v1/chat/completions',
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'Authorization': 'Bearer VerysecretKey',
    'Content-Length': data.length
  },
  timeout: 30000
};

const req = http.request(options, (res) => {
  console.log(`Status: ${res.statusCode}`);
  let body = '';
  res.on('data', (chunk) => body += chunk);
  res.on('end', () => {
    console.log('Response:', body);
  });
});

req.on('error', (e) => {
  console.error('Error:', e.message);
});

req.on('timeout', () => {
  console.error('Request timed out');
  req.destroy();
});

req.write(data);
req.end();
