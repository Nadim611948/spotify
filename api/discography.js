// api/discography.js
// Deployed on Vercel. Keeps SPOTIFY_CLIENT_SECRET on the server —
// never exposed to the browser. Squarespace's page calls this endpoint
// instead of calling Spotify directly.

export default async function handler(req, res) {
  // Allow your Squarespace site (or anywhere, if you prefer) to call this.
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const ARTIST_ID = req.query.artist_id || '7AjzowJD4IlfS3ViWpvBcB';
  const CLIENT_ID = process.env.SPOTIFY_CLIENT_ID;
  const CLIENT_SECRET = process.env.SPOTIFY_CLIENT_SECRET;

  if (!CLIENT_ID || !CLIENT_SECRET) {
    return res.status(500).json({ error: 'missing_env', message: 'Set SPOTIFY_CLIENT_ID and SPOTIFY_CLIENT_SECRET in Vercel project settings.' });
  }

  try {
    // 1. Get an access token (Client Credentials flow — server-side only)
    const tokenRes = await fetch('https://accounts.spotify.com/api/token', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Authorization': 'Basic ' + Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString('base64')
      },
      body: 'grant_type=client_credentials'
    });

    if (!tokenRes.ok) {
      return res.status(502).json({ error: 'auth_failed', status: tokenRes.status });
    }

    const { access_token: token } = await tokenRes.json();

    // 2. Fetch artist profile + full discography (albums + singles) in parallel
    const [artistRes, albumsRes] = await Promise.all([
      fetch(`https://api.spotify.com/v1/artists/${ARTIST_ID}`, {
        headers: { Authorization: `Bearer ${token}` }
      }),
      fetch(`https://api.spotify.com/v1/artists/${ARTIST_ID}/albums?include_groups=album,single&limit=50&market=US`, {
        headers: { Authorization: `Bearer ${token}` }
      })
    ]);

    if (!artistRes.ok || !albumsRes.ok) {
      const artistBody = await artistRes.text().catch(() => '');
      const albumsBody = await albumsRes.text().catch(() => '');
      return res.status(502).json({
        error: 'spotify_fetch_failed',
        artist_status: artistRes.status,
        artist_body: artistBody.slice(0, 300),
        albums_status: albumsRes.status,
        albums_body: albumsBody.slice(0, 300)
      });
    }

    const artist = await artistRes.json();
    const albumsData = await albumsRes.json();

    // 3. Spotify returns duplicate entries for reissues/regional variants —
    //    keep only the first occurrence of each title.
    const seen = new Set();
    const releases = (albumsData.items || [])
      .filter((item) => {
        const key = item.name.trim().toLowerCase();
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      })
      .map((item) => ({
        id: item.id,
        title: item.name,
        type: item.album_type,        // "album" | "single"
        date: item.release_date,
        year: (item.release_date || '').slice(0, 4),
        cover: item.images?.[0]?.url || null,
        url: item.external_urls?.spotify || `https://open.spotify.com/album/${item.id}`
      }))
      .sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));

    // 4. Cache at the edge for an hour so repeat visits don't re-hit Spotify.
    res.setHeader('Cache-Control', 's-maxage=3600, stale-while-revalidate=86400');

    return res.status(200).json({
      artist: {
        id: artist.id,
        name: artist.name,
        followers: artist.followers?.total ?? null,
        image: artist.images?.[0]?.url ?? null,
        url: artist.external_urls?.spotify ?? `https://open.spotify.com/artist/${ARTIST_ID}`
      },
      releases,
      count: releases.length
    });
  } catch (err) {
    return res.status(500).json({ error: 'server_error', message: err.message });
  }
}
