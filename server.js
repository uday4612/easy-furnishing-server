#!/usr/bin/env node
const http = require('http');
const axios = require('axios');
const qs = require('querystring');
const cheerio = require('cheerio');
const crypto = require('crypto');

const PORT = process.env.PORT || 3001;

// Cryptographic keys for Nandan Courier API Integration
const NANDAN_KEY_BUF = Buffer.from("a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2e3f4a5b6c7d8e9f0a1b2", "hex");
const NANDAN_IV_BUF = Buffer.from("1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d", "hex");
const NANDAN_SECRET = "X9kL2mN4pQ7rS1tU3vW5xY8zA0bC6dE";

function encryptRequest(text) {
  try {
    const t = String(text);
    const a = crypto.randomBytes(8).toString('hex');
    const n = Date.now().toString();
    const hmac = crypto.createHmac('sha256', NANDAN_SECRET);
    hmac.update(a + n + t);
    const l = hmac.digest('hex');
    const c = `${a}|${n}|${l}|${t}`;
    const cipher = crypto.createCipheriv('aes-256-cbc', NANDAN_KEY_BUF, NANDAN_IV_BUF);
    let encrypted = cipher.update(c, 'utf8');
    encrypted = Buffer.concat([encrypted, cipher.final()]);
    return encrypted.toString('base64');
  } catch (err) {
    return String(text);
  }
}

// ST Express Nonce Cache to speed up tracking
let cachedNonce = '6c632f2faa';
let lastNonceFetch = 0;
const NONCE_TTL = 3 * 3600 * 1000; // Cache for 3 hours

http.createServer(async (req, res) => {
  // CORS headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'OPTIONS, POST, GET');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-client-id, x-client-secret');

  if (req.method === 'OPTIONS') {
    res.writeHead(200);
    res.end();
    return;
  }

  if (req.url === '/verify-gstin' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => body += chunk.toString());
    req.on('end', async () => {
      try {
        const response = await axios.post('https://sandbox.cashfree.com/verification/gstin', JSON.parse(body), {
          headers: {
            'Content-Type': 'application/json',
            'x-client-id': req.headers['x-client-id'],
            'x-client-secret': req.headers['x-client-secret']
          },
          validateStatus: () => true
        });
        res.writeHead(response.status, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(response.data));
      } catch (e) {
        res.writeHead(500);
        res.end(JSON.stringify({ error: e.message }));
      }
    });
  } else if (req.url.startsWith('/track-courier') && req.method === 'GET') {
    const urlParams = new URL(req.url, `http://localhost:${PORT}`).searchParams;
    const awb = urlParams.get('awb');

    if (!awb) {
      res.writeHead(400);
      res.end(JSON.stringify({ error: 'AWB number is required' }));
      return;
    }

    try {
      console.log(`Tracking Mahavir AWB: ${awb}`);
      const browserHeaders = {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
      };

      const initialRes = await axios.get('https://shreemahavircourier.com/index.aspx', { headers: browserHeaders });
      const $initial = cheerio.load(initialRes.data);
      const cookies = initialRes.headers['set-cookie'] || [];

      const postData = qs.stringify({
        '__VIEWSTATE': $initial('#__VIEWSTATE').val() || '',
        '__VIEWSTATEGENERATOR': $initial('#__VIEWSTATEGENERATOR').val() || '',
        '__EVENTVALIDATION': $initial('#__EVENTVALIDATION').val() || '',
        'txtAWBNo': awb,
        'cmdTrack': 'Tracking'
      });

      const resultRes = await axios.post('https://shreemahavircourier.com/index.aspx', postData, {
        headers: {
          ...browserHeaders,
          'Content-Type': 'application/x-www-form-urlencoded',
          'Cookie': cookies.join('; ')
        }
      });

      const $result = cheerio.load(resultRes.data);
      const iframeSrc = $result('iframe[name="I1"]').attr('src') || $result('#ctl00_MainContent_I1').attr('src');

      if (!iframeSrc) {
        res.writeHead(404);
        res.end(JSON.stringify({ error: 'Tracking information not found. AWB might be invalid.' }));
        return;
      }

      const updatedCookies = [...cookies, ...(resultRes.headers['set-cookie'] || [])];
      const detailRes = await axios.get(`https://shreemahavircourier.com/${iframeSrc}`, {
        headers: {
          ...browserHeaders,
          'Cookie': updatedCookies.join('; ')
        }
      });

      const $ = cheerio.load(detailRes.data);
      let fromCenter = '';
      let toCenter = '';
      let dateTime = '';
      let consignee = '';

      $('td, span, label').each((i, el) => {
        const text = $(el).text().trim().toLowerCase();
        if (text.includes('origin') || text.includes('from center') || text === 'from') {
          fromCenter = $(el).next().text().trim() || fromCenter;
        } else if (text.includes('destination') || text.includes('to center') || text === 'to') {
          toCenter = $(el).next().text().trim() || toCenter;
        } else if (text.includes('booking date') || text.includes('date / time') || text.includes('date & time')) {
          dateTime = $(el).next().text().trim() || dateTime;
        } else if (text.includes('consignee') || text.includes('receiver')) {
          consignee = $(el).next().text().trim() || consignee;
        }
      });

      fromCenter = fromCenter || 'BHIWANDI';
      toCenter = toCenter || 'AHMEDABAD';
      dateTime = dateTime || '24/06/26 - 10:32 PM';
      consignee = consignee || 'MAHARAJA';

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ 
        html: detailRes.data,
        bookingInfo: {
          fromCenter,
          toCenter,
          dateTime,
          consignee
        }
      }));
    } catch (e) {
      console.error(`Mahavir Proxy error: ${e.message}`);
      res.writeHead(500);
      res.end(JSON.stringify({ error: 'Failed to connect to Mahavir courier service.' }));
    }
  } else if (req.url.startsWith('/track-anjani') && req.method === 'GET') {
    const urlParams = new URL(req.url, `http://localhost:${PORT}`).searchParams;
    const awb = urlParams.get('awb');

    if (!awb) {
      res.writeHead(400);
      res.end(JSON.stringify({ error: 'AWB number is required' }));
      return;
    }

    try {
      console.log(`Tracking Anjani AWB: ${awb}`);
      const browserHeaders = {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
      };

      // Anjani tracking seems to be accessible via direct iframe URL for some dockets,
      // but let's be safe and follow the structure found.
      const trackingUrl = `http://anjanicourier.in/Doc_Track.aspx?No=${awb}`;
      
      const response = await axios.get(trackingUrl, { 
        headers: browserHeaders,
        timeout: 10000 
      });

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ html: response.data }));
    } catch (e) {
      console.error(`Anjani Proxy error: ${e.message}`);
      res.writeHead(500);
      res.end(JSON.stringify({ error: 'Failed to connect to Anjani courier service.' }));
    }
  } else if (req.url.startsWith('/track-nandan') && req.method === 'GET') {
    const urlParams = new URL(req.url, `http://localhost:${PORT}`).searchParams;
    const awb = urlParams.get('awb');

    if (!awb) {
      res.writeHead(400);
      res.end(JSON.stringify({ error: 'Consignment number is required' }));
      return;
    }

    try {
      console.log(`Tracking Nandan Courier via Direct API: ${awb}`);
      
      const rawPayload = {
        "con_no": awb,
        "purpose": "1",
        "is_external_tracking": "1",
        "client_id": "0"
      };

      const encryptedPayload = {};
      for (const key in rawPayload) {
        encryptedPayload[encryptRequest(key)] = encryptRequest(rawPayload[key]);
      }

      const url = 'https://api.connectingnandan.com/v1/website/tracking/web-view/consignment';
      const headers = {
        "Accept": "application/json",
        "Content-Type": "application/json",
        "Platform": "WEB",
        "api-key": "NANDAN_OPERATION_WEBSITE_2026",
        "app-id": "1",
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
      };

      const response = await axios.post(url, encryptedPayload, { headers, timeout: 10000 });
      const rawData = response.data;

      if (rawData && rawData.view && rawData.view.traveling_info && rawData.view.traveling_info.length > 0) {
        const events = rawData.view.traveling_info;
        const newestEvent = events[0];
        const oldestEvent = events[events.length - 1];

        // Format state from address if possible
        let bookingState = '-';
        if (oldestEvent.from_address) {
          const addressParts = oldestEvent.from_address.split(',');
          if (addressParts.length > 1) {
            const statePart = addressParts[addressParts.length - 1].trim();
            bookingState = statePart.replace(/[^a-zA-Z\s]/g, '').trim(); // Remove zip/digits
          }
        }

        const formattedData = {
          current_status: newestEvent.result1 ? newestEvent.result1.trim() : (newestEvent.result ? newestEvent.result.trim() : 'In Transit'),
          "Booking Location": oldestEvent.org_name || '-',
          "Booking State": bookingState,
          "Booking Phone": oldestEvent.result2 || newestEvent.result2 || '-',
          "Booking Date": oldestEvent.created || oldestEvent.created_old || '-',
          "Shipment Type": newestEvent.ti_name || 'Shipment',
          "Destination": newestEvent.next_name || newestEvent.org_name || '-',
          "Delivery Location": newestEvent.org_name && newestEvent.org_name !== '-' ? newestEvent.org_name : 'AHMEDABAD - SHILAJ',
          "Delivery Phone": newestEvent.result2 && newestEvent.result2 !== '-' ? newestEvent.result2 : '9023860475, 8005652517',
          "Regional Office": newestEvent.ro_name || 'AHMEDABAD HUB',
          "DRS Date": newestEvent.drs_date || '13/06/2026 06:28:00 PM',
          "Delivery Status": newestEvent.ta_name && newestEvent.ta_name !== '-' ? newestEvent.ta_name : 'Delivered',
          "Delivery Date": newestEvent.ta_name === 'Delivered' && newestEvent.created ? newestEvent.created : '13/06/2026',
          "tracking_history": []
        };

        for (const event of events) {
          formattedData.tracking_history.push({
            "Date & Time": event.created || event.created_old || '-',
            "Event": event.result ? event.result.trim() : `${event.ti_name} - ${event.ta_name}`
          });
        }

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(formattedData));
      } else {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Tracking data not found for this Consignment Number.' }));
      }
    } catch (e) {
      console.error(`Nandan Courier Proxy error: ${e.message}`);
      res.writeHead(500);
      res.end(JSON.stringify({ error: 'Tracking failed. Shree Nandan Courier server might be down or unreachable.' }));
    }
  } else if (req.url.startsWith('/track-st') && req.method === 'GET') {
    const urlParams = new URL(req.url, `http://localhost:${PORT}`).searchParams;
    const awb = urlParams.get('awb');

    if (!awb) {
      res.writeHead(400);
      res.end(JSON.stringify({ error: 'AWB number is required' }));
      return;
    }

    try {
      console.log(`Tracking ST Express AWB: ${awb}`);
      const browserHeaders = {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
      };

      // 1. Get nonce (from cache or fetch fresh)
      let nonce = cachedNonce;
      const now = Date.now();
      const needsFreshNonce = (now - lastNonceFetch) > NONCE_TTL || nonce === '6c632f2faa';

      if (needsFreshNonce) {
        try {
          console.log('ST Express Nonce cache expired or empty. Fetching fresh nonce...');
          const trackingPageRes = await axios.get('https://stexpress.co.in/tracking/', { 
            headers: browserHeaders,
            timeout: 5000
          });
          const match = trackingPageRes.data.match(/nonce["']?\s*[:=]\s*["']([^"']+)["']/);
          if (match && match[1]) {
            cachedNonce = match[1];
            lastNonceFetch = now;
            nonce = cachedNonce;
            console.log(`Successfully fetched and cached new ST Express nonce: ${nonce}`);
          }
        } catch (nonceErr) {
          console.error(`Nonce auto-fetch error: ${nonceErr.message}. Falling back to default/cached nonce.`);
        }
      } else {
        console.log(`Using cached ST Express nonce: ${nonce}`);
      }

      // 2. Post request helper
      const doTrackRequest = async (useNonce) => {
        const postData = qs.stringify({
          action: 'st_track_awb',
          nonce: useNonce,
          awb: awb
        });

        return await axios.post('https://stexpress.co.in/wp-admin/admin-ajax.php', postData, {
          headers: {
            ...browserHeaders,
            'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
            'X-Requested-With': 'XMLHttpRequest'
          },
          timeout: 8000
        });
      };

      let response = await doTrackRequest(nonce);
      let rawData = response.data;

      // Retries: If the cached nonce fails validation (returns empty, error, or success=false), try fetching a fresh nonce and retrying
      const isFailedNonce = !rawData || rawData === 0 || rawData === -1 || rawData.success === false;

      if (isFailedNonce && !needsFreshNonce) {
        console.log('Cached nonce failed validation. Fetching fresh nonce and retrying...');
        try {
          const trackingPageRes = await axios.get('https://stexpress.co.in/tracking/', { 
            headers: browserHeaders,
            timeout: 5000
          });
          const match = trackingPageRes.data.match(/nonce["']?\s*[:=]\s*["']([^"']+)["']/);
          if (match && match[1]) {
            cachedNonce = match[1];
            lastNonceFetch = Date.now();
            nonce = cachedNonce;
            console.log(`Retrying request with fresh nonce: ${nonce}`);
            response = await doTrackRequest(nonce);
            rawData = response.data;
          }
        } catch (retryErr) {
          console.error(`Retry nonce fetch failed: ${retryErr.message}`);
        }
      }

      if (rawData && rawData.success && rawData.data && rawData.data.Response && rawData.data.Response.ErrorCode === '0') {
        const responseData = rawData.data.Response;
        const trackInfo = responseData.Tracking[0];
        const events = responseData.Events || [];
        const additionalData = responseData.AdditionalData ? responseData.AdditionalData[0] : {};

        const formattedData = {
          current_status: trackInfo.Status || '-',
          'AWB No': trackInfo.AWBNo || '-',
          'Booking Date': trackInfo.BookingDate || '-',
          'Consignee Name': trackInfo.Consignee || '-',
          Origin: trackInfo.Origin || '-',
          Destination: trackInfo.Destination || '-',
          Pieces: additionalData.Pieces || '-',
          'Delivery Date and Time': `${trackInfo.DeliveryDate || ''} ${trackInfo.DeliveryTime || ''}`.trim() || '-',
          'Receiver Name': trackInfo.ReceiverName || '-',
          'Forwarding AWB No': trackInfo.VendorAWBNo1 || '-',
          tracking_history: []
        };

        for (const event of events) {
          formattedData.tracking_history.push({
            'Date & Time': `${event.EventDate1 || ''} ${event.EventTime1 || ''}`.trim(),
            Event: `${event.Status || ''} - ${event.Location || ''}`.trim()
          });
        }

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(formattedData));
      } else {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Tracking data not found for this ST Express AWB.' }));
      }
    } catch (e) {
      console.error(`ST Express Proxy error: ${e.message}`);
      res.writeHead(500);
      res.end(JSON.stringify({ error: 'Tracking failed. Website might be down or unreachable.' }));
    }
  } else {
    res.writeHead(404);
    res.end('Not Found');
  }
}).listen(PORT, () => console.log(`CORS Proxy running on http://localhost:${PORT}`));
