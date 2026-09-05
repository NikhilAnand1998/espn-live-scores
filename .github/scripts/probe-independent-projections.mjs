const sources = {
  better: 'https://betterprojections.com/rankings',
  imagine: 'https://imaginefantasyfootball.com/scouting/season-forecast/half/'
};

for (const [name, url] of Object.entries(sources)) {
  console.log(`\n===== ${name} ${url} =====`);
  try {
    const response = await fetch(url, {
      headers: {
        'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/140 Safari/537.36',
        accept: 'text/html,application/xhtml+xml,*/*'
      }
    });
    const text = await response.text();
    console.log('status', response.status, 'bytes', text.length, 'type', response.headers.get('content-type'));
    for (const needle of ['Puka Nacua', 'Half-PPR', 'halfPpr', 'half_ppr', 'expectedPoints', 'projections', '__NEXT_DATA__', 'application/ld+json']) {
      const index = text.indexOf(needle);
      console.log(needle, index);
      if (index >= 0) console.log(text.slice(Math.max(0, index - 500), index + 1500).replace(/\s+/g, ' '));
    }
    console.log('tables', (text.match(/<table/gi) || []).length, 'scripts', (text.match(/<script/gi) || []).length);
  } catch (error) {
    console.log('ERROR', error.stack || error.message);
  }
}
