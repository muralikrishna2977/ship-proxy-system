const net = require('net');
const http = require('http');

const OFFSHORE_HOST = process.env.OFFSHORE_HOST || 'localhost';
const OFFSHORE_PORT = process.env.OFFSHORE_PORT ? +process.env.OFFSHORE_PORT : 9999;
const LISTEN_PORT = process.env.PORT ? +process.env.PORT : 8080;

const TYPE = {
  REQUEST: 0,
  RESPONSE: 1,
  TUNNEL_DATA: 2,
  TUNNEL_OPEN: 3,
  TUNNEL_CLOSE: 4,
  ERROR: 5
};

let nextReqId = 1;
function allocReqId() { return nextReqId++; }

function sendFrame(socket, type, reqId, payload) {
  if (!Buffer.isBuffer(payload)) payload = Buffer.from(payload || '');
  const header = Buffer.alloc(9);
  header.writeUInt32BE(payload.length, 0);
  header.writeUInt8(type, 4);
  header.writeUInt32BE(reqId >>> 0, 5);
  socket.write(Buffer.concat([header, payload]));
}

function attachFrameReader(socket, onFrame) {
  let buf = Buffer.alloc(0);
  socket.on('data', (chunk) => {
    buf = Buffer.concat([buf, chunk]);
    while (buf.length >= 9) {
      const len = buf.readUInt32BE(0);
      const type = buf.readUInt8(4);
      const reqId = buf.readUInt32BE(5);
      if (buf.length < 9 + len) break;
      const payload = buf.slice(9, 9 + len);
      buf = buf.slice(9 + len);
      onFrame(type, reqId, payload);
    }
  });
}

let offshoreSocket = null;
function connectOffshore(cb) {
  offshoreSocket = net.connect(OFFSHORE_PORT, OFFSHORE_HOST, () => {
    console.log('Connected to Offshore', OFFSHORE_HOST + ':' + OFFSHORE_PORT);
    if (cb) cb();
  });

  offshoreSocket.on('error', (err) => {
    console.error('Offshore socket error', err.message);
    setTimeout(() => {
      console.log('Reconnecting to Offshore...');
      connectOffshore();
    }, 1000);
  });

  offshoreSocket.on('close', () => {
    console.log('Offshore socket closed, reconnecting...');
    setTimeout(connectOffshore, 1000);
  });
}

connectOffshore();

const pending = new Map();

function ensureReader() {
  if (!offshoreSocket) return;
  attachFrameReader(offshoreSocket, (type, reqId, payload) => {
    const entry = pending.get(reqId);
    if (!entry) {
      if (type === TYPE.ERROR) console.error('Offshore error:', payload.toString());
      return;
    }

    if (entry.mode === 'HTTP') {
      if (type === TYPE.RESPONSE) {
        entry.res.write(payload);
        entry.res.end();
        pending.delete(reqId);
        processQueue();
      } else if (type === TYPE.ERROR) {
        entry.res.writeHead(502, {'Content-Type':'text/plain'});
        entry.res.end('Offshore error: ' + payload.toString());
        pending.delete(reqId);
        processQueue();
      }
    } else if (entry.mode === 'CONNECT') {
      if (type === TYPE.RESPONSE) {
        entry.clientSocket.write(payload);
      } else if (type === TYPE.TUNNEL_DATA) {
        entry.clientSocket.write(payload);
      } else if (type === TYPE.TUNNEL_CLOSE) {
        try { entry.clientSocket.end(); } catch(e){}
        pending.delete(reqId);
        processQueue();
      } else if (type === TYPE.ERROR) {
        try {
          entry.clientSocket.write('HTTP/1.1 502 Bad Gateway\r\n\r\n' + payload.toString());
          entry.clientSocket.end();
        } catch(e){}
        pending.delete(reqId);
        processQueue();
      }
    }
  });
}
setTimeout(ensureReader, 200);

const queue = [];
let processing = false; 


function processQueue() {
  if (processing) return;
  if (queue.length === 0) return;
  if (!offshoreSocket || offshoreSocket.destroyed) {
    console.log('Offshore not connected; waiting...');
    return;
  }
  processing = true;
  const job = queue.shift();

  if (job.type === 'HTTP') {
    const reqId = allocReqId();
    pending.set(reqId, { res: job.res, mode: 'HTTP' });

    const req = job.req;
    let firstLine = `${req.method} ${req.url} HTTP/${req.httpVersion}\r\n`;
    let headers = '';
    for (const [k,v] of Object.entries(req.headers)) {
      headers += `${k}: ${v}\r\n`;
    }
    const headerEnd = '\r\n';
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const body = Buffer.concat(chunks);
      const raw = Buffer.concat([Buffer.from(firstLine + headers + headerEnd), body]);
      sendFrame(offshoreSocket, TYPE.REQUEST, reqId, raw);
      processing = false;
    });
  } else if (job.type === 'CONNECT') {
    const reqId = allocReqId();
    pending.set(reqId, { clientSocket: job.clientSocket, mode: 'CONNECT' });

    const raw = `CONNECT ${job.req.url} HTTP/${job.req.httpVersion}\r\nHost: ${job.req.url}\r\n\r\n`;
    sendFrame(offshoreSocket, TYPE.REQUEST, reqId, Buffer.from(raw));

    job.clientSocket.on('data', (chunk) => {
      sendFrame(offshoreSocket, TYPE.TUNNEL_DATA, reqId, chunk);
    });

    job.clientSocket.on('end', () => {
      sendFrame(offshoreSocket, TYPE.TUNNEL_CLOSE, reqId, Buffer.alloc(0));
    });

    job.clientSocket.on('error', () => {
      sendFrame(offshoreSocket, TYPE.TUNNEL_CLOSE, reqId, Buffer.alloc(0));
    });
  }
}

const server = http.createServer((req, res) => {
  queue.push({ type: 'HTTP', req, res });
  processQueue();
});

server.on('connect', (req, clientSocket, head) => {
  queue.push({ type: 'CONNECT', req, clientSocket, head });
  processQueue();
});

server.listen(LISTEN_PORT, () => {
  console.log('Ship Proxy listening on port', LISTEN_PORT);
});
