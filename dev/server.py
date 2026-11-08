"""Serveur de test : sert le dossier de l'extension et relaie les requêtes
externes via /proxy?url=... (remplace le service worker hors de Chrome).
Lancer depuis la racine du projet : python3 dev/server.py
"""
import http.server
import os
import subprocess
import urllib.parse

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


class Handler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *a, **kw):
        super().__init__(*a, directory=ROOT, **kw)

    def do_GET(self):
        if self.path.split('?')[0].endswith('.mp4'):
            return self.send_video()
        if not self.path.startswith('/proxy?'):
            return super().do_GET()
        url = urllib.parse.parse_qs(urllib.parse.urlparse(self.path).query)['url'][0]
        # curl plutôt qu'urllib : certains serveurs coupent la connexion TLS de Python.
        r = subprocess.run(['curl', '-sSL', '--max-time', '15', '-w', '\n%{http_code}', url],
                           capture_output=True)
        body, _, code = r.stdout.rpartition(b'\n')
        status = int(code or 502) if r.returncode == 0 else 502
        ctype = 'application/json' if body[:1] in (b'{', b'[') else 'text/plain; charset=utf-8'
        self.send_response(status)
        self.send_header('Content-Type', ctype)
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    # Requêtes Range : sans elles, le navigateur ne peut pas avancer dans la vidéo.
    def send_video(self):
        path = self.translate_path(self.path.split('?')[0])
        if not os.path.isfile(path):
            return self.send_error(404)
        size = os.path.getsize(path)
        start, end = 0, size - 1
        rng = self.headers.get('Range', '')
        if rng.startswith('bytes='):
            a, _, b = rng[6:].partition('-')
            start = int(a or 0)
            end = min(int(b), size - 1) if b else size - 1
            self.send_response(206)
            self.send_header('Content-Range', f'bytes {start}-{end}/{size}')
        else:
            self.send_response(200)
        self.send_header('Accept-Ranges', 'bytes')
        self.send_header('Content-Type', 'video/mp4')
        self.send_header('Content-Length', str(end - start + 1))
        self.end_headers()
        with open(path, 'rb') as f:
            f.seek(start)
            try:
                self.wfile.write(f.read(end - start + 1))
            except (BrokenPipeError, ConnectionResetError):
                pass


http.server.ThreadingHTTPServer(('127.0.0.1', 8765), Handler).serve_forever()
