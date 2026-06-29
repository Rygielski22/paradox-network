# Paradox Network — VPS setup

## First deploy

```bash
git clone https://github.com/YOUR_USER/paradox-network.git /root/paradox-network
cd /root/paradox-network
cp config.example.json config.json   # edit port if Meteor already uses 19132
chmod +x deploy.sh
bash deploy.sh
```

`deploy.sh` installs cmake + build tools, runs `npm install`, builds the pack, starts pm2.

## Pull updates

```bash
cd /root/paradox-network && git pull && bash deploy.sh
```

Or quick restart without full reinstall:

```bash
cd /root/paradox-network && git pull && pm2 restart paradox-proxy
```

## Firewall

Open **UDP** on your proxy port (default `19132`) in the host panel — not just `ufw`.

```bash
ss -ulnp | grep 19132
pm2 logs paradox-proxy --lines 30
```