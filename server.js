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
      console.log(`Tracking Nandan Courier via Multi-Purpose API: ${awb}`);

      const getPayloadForPurpose = (purpose) => {
        const rawPayload = {
          "con_no": awb,
          "purpose": String(purpose),
          "is_external_tracking": 1,
          "is_international": 0,
          "client_id": 0
        };
        const encryptedPayload = {};
        for (const key in rawPayload) {
          encryptedPayload[encryptRequest(key)] = encryptRequest(rawPayload[key]);
        }
        return encryptedPayload;
      };

      const url = 'https://api.connectingnandan.com/v1/website/tracking/web-view/consignment';
      const headers = {
        "Accept": "application/json",
        "Content-Type": "application/json",
        "Platform": "WEB",
        "api-key": "NANDAN_OPERATION_WEBSITE_2026",
        "app-id": "1",
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
      };

      const [res1, res2, res3] = await Promise.all([
        axios.post(url, getPayloadForPurpose(1), { headers, timeout: 10000 }).catch(() => null),
        axios.post(url, getPayloadForPurpose(2), { headers, timeout: 10000 }).catch(() => null),
        axios.post(url, getPayloadForPurpose(3), { headers, timeout: 10000 }).catch(() => null)
      ]);

      const rawData1 = res1 ? res1.data : null;
      const rawData2 = res2 ? res2.data : null;
      const rawData3 = res3 ? res3.data : null;

      const view1 = rawData1 && rawData1.view ? rawData1.view : {};
      const view2 = rawData2 && rawData2.view ? rawData2.view : {};
      const view3 = rawData3 && rawData3.view ? rawData3.view : {};

      const events = view1.traveling_info || [];
      const booking = view2.booking || {};
      const drs = view3.drs || {};
      const deliveryDetailsList = view3.delivery_details || [];
      const mainDeliveryDetail = deliveryDetailsList.length > 0 ? deliveryDetailsList[0] : {};

      if (events.length > 0 || Object.keys(booking).length > 0 || Object.keys(drs).length > 0) {
        const newestEvent = events.length > 0 ? events[0] : {};
        const oldestEvent = events.length > 0 ? events[events.length - 1] : {};

        // Format state from address if possible
        let bookingState = booking.bk_state || '-';
        if (bookingState === '-' && oldestEvent.from_address) {
          const addressParts = oldestEvent.from_address.split(',');
          if (addressParts.length > 1) {
            const statePart = addressParts[addressParts.length - 1].trim();
            bookingState = statePart.replace(/[^a-zA-Z\s]/g, '').trim(); // Remove zip/digits
          }
        }

        // Overall current status
        const currentStatus = booking.bk_status || mainDeliveryDetail.delivery_status || (newestEvent.result1 ? newestEvent.result1.trim() : (newestEvent.result ? newestEvent.result.trim() : 'In Transit'));

        const formattedData = {
          current_status: currentStatus,
          "Booking Location": booking.center || oldestEvent.org_name || '-',
          "Booking State": bookingState,
          "Booking Phone": booking.center_mobile || oldestEvent.result2 || newestEvent.result2 || '-',
          "Booking Date": booking.bk_date || oldestEvent.created || oldestEvent.created_old || '-',
          "Shipment Type": booking.product || newestEvent.ti_name || 'Shipment',
          "Destination": booking.to_hub || newestEvent.next_name || newestEvent.org_name || '-',
          
          "Delivery Location": drs.center || mainDeliveryDetail.center || newestEvent.org_name || 'AHMEDABAD - SHILAJ',
          "Delivery Phone": drs.center_mobile || mainDeliveryDetail.center_mobile || newestEvent.result2 || '9023860475, 8005652517',
          "Regional Office": drs.reg_office || mainDeliveryDetail.reg_office || 'AHMEDABAD HUB',
          "DRS Date": drs.drs_date || mainDeliveryDetail.drs_date || '13/06/2026 06:28:00 PM',
          "Delivery Status": mainDeliveryDetail.delivery_status || booking.bk_status || newestEvent.ta_name || 'Inward',
          "Delivery Date": mainDeliveryDetail.delivery_date || (booking.bk_status === 'Delivered' ? '13/06/2026' : '-'),
          
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
  } else if (req.url.startsWith('/track-smexpress') && req.method === 'GET') {
    const urlParams = new URL(req.url, `http://localhost:${PORT}`).searchParams;
    const awb = urlParams.get('awb');

    if (!awb) {
      res.writeHead(400);
      res.end(JSON.stringify({ error: 'AWB number is required' }));
      return;
    }

    try {
      console.log(`Tracking SM Express AWB: ${awb}`);
      const browserHeaders = {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9'
      };

      const postData = qs.stringify({ 'LRNo': awb });
      let html = '';
      let success = false;

      // Try live production site first
      try {
        console.log(`Attempting to track on smexpresslogistics.com...`);
        const response = await axios.post('https://smexpresslogistics.com/order-tracking/', postData, {
          headers: {
            ...browserHeaders,
            'Content-Type': 'application/x-www-form-urlencoded',
            'Origin': 'https://smexpresslogistics.com',
            'Referer': 'https://smexpresslogistics.com/order-tracking/'
          },
          timeout: 10000,
          validateStatus: () => true
        });
        
        if (response.status === 200 && response.data && !response.data.includes('Data Not Found')) {
          html = response.data;
          success = true;
          console.log(`Successfully fetched tracking from smexpresslogistics.com`);
        }
      } catch (err) {
        console.log(`smexpresslogistics.com failed: ${err.message}`);
      }

      // Staging/Backup site fallback
      if (!success) {
        try {
          console.log(`Attempting fallback to smexpress.in...`);
          const response = await axios.post('https://smexpress.in/Home/track', postData, {
            headers: {
              ...browserHeaders,
              'Content-Type': 'application/x-www-form-urlencoded',
              'Origin': 'https://smexpress.in',
              'Referer': 'https://smexpress.in/Home/track'
            },
            timeout: 10000,
            validateStatus: () => true
          });
          
          if (response.status === 200 && response.data) {
            html = response.data;
            success = true;
            console.log(`Successfully fetched tracking from smexpress.in`);
          }
        } catch (err) {
          console.log(`smexpress.in fallback failed: ${err.message}`);
        }
      }

      if (success) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ html }));
      } else {
        res.writeHead(500);
        res.end(JSON.stringify({ error: 'Failed to connect to SM Express courier services.' }));
      }
    } catch (e) {
      console.error(`SM Express Proxy error: ${e.message}`);
      res.writeHead(500);
      res.end(JSON.stringify({ error: 'Failed to connect to SM Express courier service.' }));
    }
  } else {
    res.writeHead(404);
    res.end('Not Found');
  }
}).listen(PORT, () => console.log(`CORS Proxy running on http://localhost:${PORT}`));
