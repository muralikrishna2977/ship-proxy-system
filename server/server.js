const net = require('net');
const http = require('http');

const LISTEN_PORT = process.env.PORT ? +process.env.PORT : 9999;

const TYPE = {
  REQUEST: 0,
  RESPONSE: 1,
  TUNNEL_DATA: 2,
  TUNNEL_OPEN: 3,
  TUNNEL_CLOSE: 4,
  ERROR: 5
};

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

function parseHostFromRequestBytes(reqBytes) {
  const s = reqBytes.toString('utf8');
  const lines = s.split('\r\n');
  for (let i = 1; i < lines.length; i++) {
    const l = lines[i];
    if (!l) break;
    const idx = l.toLowerCase().indexOf('host:');
    if (idx === 0) {
      return l.slice(5).trim();
    }
  }
  return null;
}

const server = net.createServer((shipSocket) => {
  console.log('Ship connected from', shipSocket.remoteAddress + ':' + shipSocket.remotePort);

  const tunnels = new Map();

  attachFrameReader(shipSocket, (type, reqId, payload) => {
    try {
      if (type === TYPE.REQUEST) {
        const reqStr = payload.toString('utf8');
        const firstLine = reqStr.split('\r\n')[0] || '';
        const parts = firstLine.split(' ');
        const method = parts[0] || '';
        const urlOrHost = parts[1] || '';

        if (method === 'CONNECT') {
          const hostport = urlOrHost;
          const [host, portStr] = hostport.split(':');
          const port = portStr ? +portStr : 443;
          console.log(`CONNECT request (reqId=${reqId}) => ${host}:${port}`);

          const remote = net.connect(port, host, () => {
            sendFrame(shipSocket, TYPE.RESPONSE, reqId, Buffer.from('HTTP/1.1 200 Connection Established\r\n\r\n'));
            tunnels.set(reqId, remote);

            remote.on('data', (chunk) => {
              sendFrame(shipSocket, TYPE.TUNNEL_DATA, reqId, chunk);
            });

            remote.on('end', () => {
              sendFrame(shipSocket, TYPE.TUNNEL_CLOSE, reqId, Buffer.from(''));
              tunnels.delete(reqId);
            });

            remote.on('error', (err) => {
              sendFrame(shipSocket, TYPE.ERROR, reqId, Buffer.from('Remote connection error: ' + err.message));
              remote.destroy();
              tunnels.delete(reqId);
            });
          });

          remote.on('error', (err) => {
            sendFrame(shipSocket, TYPE.ERROR, reqId, Buffer.from('Connect error: ' + err.message));
          });
        } else {
          const hostHeader = parseHostFromRequestBytes(payload) || '';
          let path = urlOrHost;
          try {
            const u = new URL(urlOrHost);
            path = u.pathname + u.search;
          } catch (e) {
            console.log(e);
          }

          const options = {
            method,
            headers: {},
            host: hostHeader,
            port: 80,
            path
          };

          const raw = payload.toString('utf8');
          const headerLines = raw.split('\r\n');
          for (let i = 1; i < headerLines.length; i++) {
            const line = headerLines[i];
            if (!line) break;
            const idx = line.indexOf(':');
            if (idx > -1) {
              const k = line.slice(0, idx).trim();
              let v = line.slice(idx + 1).trim();
              if (k.toLowerCase() === 'proxy-connection') continue;
              options.headers[k] = v;
            }
          }

          const headerEnd = raw.indexOf('\r\n\r\n');
          let body = null;
          if (headerEnd !== -1) {
            body = Buffer.from(raw.slice(headerEnd + 4), 'utf8');
          }

          const proxyReq = http.request(options, (proxyRes) => {
            const chunks = [];
            proxyRes.on('data', (c) => chunks.push(c));
            proxyRes.on('end', () => {
              const head = `HTTP/${proxyRes.httpVersion} ${proxyRes.statusCode} ${proxyRes.statusMessage}\r\n`;
              const headersText = Object.entries(proxyRes.headers).map(([k, v]) => `${k}: ${v}`).join('\r\n');
              const bodyBuf = Buffer.concat(chunks || []);
              const respBytes = Buffer.concat([Buffer.from(head + headersText + '\r\n\r\n'), bodyBuf]);
              sendFrame(shipSocket, TYPE.RESPONSE, reqId, respBytes);
            });
          });

          proxyReq.on('error', (err) => {
            sendFrame(shipSocket, TYPE.ERROR, reqId, Buffer.from('Upstream error: ' + err.message));
          });

          if (body && body.length) proxyReq.write(body);
          proxyReq.end();
        }
      } else if (type === TYPE.TUNNEL_DATA) {
        const remote = tunnels.get(reqId);
        if (remote) remote.write(payload);
      } else if (type === TYPE.TUNNEL_CLOSE) {
        const remote = tunnels.get(reqId);
        if (remote) {
          remote.end();
          tunnels.delete(reqId);
        }
      } else if (type === TYPE.ERROR) {
        console.error('Error frame from ship:', payload.toString());
      } else {
        console.warn('Unknown frame type', type);
      }
    } catch (err) {
      console.error('Frame handling error', err);
      sendFrame(shipSocket, TYPE.ERROR, reqId || 0, Buffer.from('Server internal error: ' + err.message));
    }
  });

  shipSocket.on('close', () => {
    console.log('Ship disconnected');
  });
});

server.on('error', (err) => {
  console.error('Server error', err);
});

server.listen(LISTEN_PORT, () => {
  console.log('Offshore Proxy listening on', LISTEN_PORT);
});
