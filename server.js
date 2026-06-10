const express = require('express');
const cors = require('cors');
const { spawn, execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const https = require('https');

const app = express();
app.use(cors());
app.use(express.json());

// ─── Installe yt-dlp au démarrage ─────────────────────────────────────────────
const YTDLP_PATH = '/tmp/yt-dlp';

function installYtDlp() {
  if (fs.existsSync(YTDLP_PATH)) {
    console.log('✅ yt-dlp déjà présent');
    return;
  }
  console.log('📥 Installation de yt-dlp...');
  try {
    execSync(
      `curl -L https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp -o ${YTDLP_PATH} && chmod +x ${YTDLP_PATH}`,
      { stdio: 'inherit', timeout: 60000 }
    );
    console.log('✅ yt-dlp installé !');
  } catch (e) {
    console.error('❌ Erreur installation yt-dlp:', e.message);
  }
}

installYtDlp();

// ─── Routes ───────────────────────────────────────────────────────────────────

app.get('/', (req, res) => {
  res.json({
    status: 'ok',
    message: 'YTMusic API fonctionne !',
    ytdlp: fs.existsSync(YTDLP_PATH) ? 'installé' : 'manquant',
  });
});

// Infos vidéo (titre, durée, thumbnail)
app.post('/info', async (req, res) => {
  const { url } = req.body;
  if (!url) return res.status(400).json({ error: 'URL manquante' });

  console.log('🔍 Info pour:', url);

  const args = [
    '--no-warnings',
    '--skip-download',
    '--print', '%(title)s|||%(duration)s|||%(uploader)s|||%(thumbnail)s',
    '--no-playlist',
    url,
  ];

  let output = '';
  let error  = '';

  const proc = spawn(YTDLP_PATH, args);
  proc.stdout.on('data', d => output += d.toString());
  proc.stderr.on('data', d => error  += d.toString());

  proc.on('close', code => {
    if (code !== 0) {
      console.error('❌ yt-dlp info error:', error);
      return res.status(500).json({ error: 'Impossible de récupérer les infos' });
    }
    const parts = output.trim().split('|||');
    res.json({
      title:     parts[0] || 'Inconnu',
      duration:  parseInt(parts[1]) || 0,
      uploader:  parts[2] || '',
      thumbnail: parts[3] || '',
      is_playlist: false,
      count: 1,
    });
  });
});

// Téléchargement avec SSE (Server-Sent Events)
app.post('/download', (req, res) => {
  const { url, format = 'mp3' } = req.body;
  if (!url) return res.status(400).json({ error: 'URL manquante' });

  console.log('🎵 Téléchargement:', url, '| Format:', format);

  // Headers SSE
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();

  const send = (obj) => res.write('data: ' + JSON.stringify(obj) + '\n\n');

  send({ type: 'start', msg: 'Téléchargement démarré...' });

  const outTemplate = `/tmp/%(title)s.%(ext)s`;

  const args = [
    '--no-warnings',
    '-x',
    '--audio-format', format,
    '--audio-quality', '0',
    '-o', outTemplate,
    '--no-playlist',
    '--newline',
    url,
  ];

  const proc = spawn(YTDLP_PATH, args);
  let title    = 'Musique';
  let filename = '';

  proc.stdout.on('data', (data) => {
    const line = data.toString().trim();
    if (!line) return;
    console.log('[yt-dlp]', line);

    // Progression
    const pctMatch = line.match(/(\d+\.?\d*)%/);
    if (pctMatch) {
      const pct   = parseFloat(pctMatch[1]);
      const speed = (line.match(/at\s+([\d.]+\w+\/s)/) || [])[1] || '';
      const eta   = (line.match(/ETA\s+([\d:]+)/) || [])[1] || '';
      send({ type: 'progress', percent: pct, speed, eta });
    }

    // Destination (nom du fichier)
    const destMatch = line.match(/\[download\] Destination: (.+)/);
    if (destMatch) {
      filename = destMatch[1].trim();
      title    = path.basename(filename, path.extname(filename));
    }

    // Conversion
    if (line.includes('[ExtractAudio]') || line.includes('Destination:') && line.includes(`.${format}`)) {
      send({ type: 'converting', msg: 'Conversion audio...' });
      const convMatch = line.match(/Destination: (.+)/);
      if (convMatch) filename = convMatch[1].trim();
    }
  });

  proc.stderr.on('data', (data) => {
    console.error('[yt-dlp err]', data.toString().trim());
  });

  proc.on('close', (code) => {
    if (code !== 0) {
      send({ type: 'error', msg: 'Échec du téléchargement. Vérifie l\'URL.' });
      res.end();
      return;
    }

    // Cherche le fichier converti dans /tmp
    const expectedFile = filename.replace(/\.[^.]+$/, `.${format}`);
    let finalFile = expectedFile;

    if (!fs.existsSync(finalFile)) {
      // Cherche dans /tmp
      try {
        const files = fs.readdirSync('/tmp')
          .filter(f => f.endsWith(`.${format}`))
          .map(f => ({ name: f, time: fs.statSync(`/tmp/${f}`).mtime }))
          .sort((a, b) => b.time - a.time);
        if (files.length > 0) {
          finalFile = `/tmp/${files[0].name}`;
          title = path.basename(files[0].name, `.${format}`);
        }
      } catch {}
    }

    const finalName = path.basename(finalFile);
    console.log('✅ Fichier prêt:', finalName);

    send({
      type:     'ready',
      title:    title,
      filename: finalName,
      path:     finalFile,
    });

    res.end();
  });
});

// Récupère le fichier (pour le télécharger sur l'Android)
app.get('/fetch/:filename', (req, res) => {
  const filename = decodeURIComponent(req.params.filename);
  const filepath = `/tmp/${filename}`;

  if (!fs.existsSync(filepath)) {
    // Cherche un fichier similaire
    try {
      const ext   = path.extname(filename);
      const files = fs.readdirSync('/tmp').filter(f => f.endsWith(ext));
      if (files.length > 0) {
        const found = `/tmp/${files[files.length - 1]}`;
        return res.download(found, filename);
      }
    } catch {}
    return res.status(404).json({ error: `Fichier introuvable: ${filename}` });
  }

  res.download(filepath, filename, (err) => {
    if (!err) {
      // Supprime après envoi pour libérer la mémoire
      setTimeout(() => {
        try { fs.unlinkSync(filepath); } catch {}
      }, 5000);
    }
  });
});

// Liste les fichiers dispo dans /tmp
app.get('/files', (req, res) => {
  try {
    const exts  = ['.mp3', '.flac', '.m4a', '.ogg', '.opus'];
    const files = fs.readdirSync('/tmp')
      .filter(f => exts.includes(path.extname(f).toLowerCase()))
      .map(f => {
        const stat = fs.statSync(`/tmp/${f}`);
        return {
          name:   f,
          size:   stat.size,
          date:   stat.mtime.toLocaleDateString('fr-FR'),
          format: path.extname(f).slice(1).toUpperCase(),
        };
      })
      .sort((a, b) => b.date - a.date);
    res.json({ files });
  } catch (e) {
    res.json({ files: [] });
  }
});

// ─── Démarrage ────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 Serveur démarré sur le port ${PORT}`);
});
