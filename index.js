// tf2_trade_bot_backend/index.js

require('dotenv').config();
const express = require('express');
const multer = require('multer');
const fs = require('fs');
const path = require('path');
const SteamUser = require('steam-user');
const SteamTotp = require('steam-totp');
const SteamCommunity = require('steamcommunity');
const TradeOfferManager = require('steam-tradeoffer-manager');
const axios = require('axios');

const app = express();
const PORT = process.env.PORT || 3000;
const BACKPACK_API_KEY = '67fa775a97e93a453d02413b';
const DISCORD_WEBHOOK = 'https://discord.com/api/webhooks/1360621809564913765/j7Z_VytximMST91epMkqotXilx14gCDCSYV8nBIT8TKvSpDEgVt6ke2UJblvbUP-Hw2c';

app.use(express.json());
const upload = multer({ dest: 'mafiles/' });

// Store bot clients
const bots = {};

function sendDiscordNotification(content) {
  axios.post(DISCORD_WEBHOOK, {
    content: content
  }).catch(err => console.error('Discord Webhook Error:', err.message));
}

function formatItemList(items) {
  return items.map(item => `• ${item.market_hash_name}`).join('\n');
}

function formatTotalValue(items, priceMap) {
  let total = 0;
  items.forEach(item => {
    const itemPrice = priceMap[item.market_hash_name]?.value || 0;
    total += itemPrice;
  });
  const refined = (total / 9).toFixed(2); // 9 scrap = 1 ref
  const keys = (refined / 60).toFixed(2); // 60 ref = 1 key (approx)
  const usd = (keys * 1.9).toFixed(2); // 1 key ≈ $1.90 (est)
  return { refined, keys, usd };
}

function loginBot(mafilePath) {
  const mafile = JSON.parse(fs.readFileSync(mafilePath));
  const client = new SteamUser();
  const community = new SteamCommunity();
  const manager = new TradeOfferManager({
    steam: client,
    community: community,
    language: 'en'
  });

  const logOnOptions = {
    accountName: mafile.account_name,
    password: mafile.password,
    twoFactorCode: SteamTotp.generateAuthCode(mafile.shared_secret)
  };

  client.logOn(logOnOptions);

  client.on('loggedOn', () => {
    bots[client.steamID.getSteamID64()] = { client, community, manager, mafile, mafilePath };
    console.log(`[+] Logged in: ${client.steamID.getSteamID64()}`);
    sendDiscordNotification(`✅ Logged in as ${mafile.account_name} (${client.steamID.getSteamID64()})`);

    manager.on('sentOfferChanged', (offer, oldState) => {
      const partnerID = offer.partner.getSteamID64();
      if (offer.state === TradeOfferManager.ETradeOfferState.Accepted) {
        sendDiscordNotification(`✅ Trade Accepted!\nBot: ${mafile.account_name}\nTrade ID: ${offer.id}\nPartner: https://steamcommunity.com/profiles/${partnerID}`);
      } else if (offer.state === TradeOfferManager.ETradeOfferState.Declined) {
        sendDiscordNotification(`❌ Trade Declined.\nBot: ${mafile.account_name}\nTrade ID: ${offer.id}\nPartner: https://steamcommunity.com/profiles/${partnerID}`);
      } else if (offer.state === TradeOfferManager.ETradeOfferState.Canceled) {
        sendDiscordNotification(`⚠️ Trade Canceled.\nBot: ${mafile.account_name}\nTrade ID: ${offer.id}\nPartner: https://steamcommunity.com/profiles/${partnerID}`);
      } else if (offer.state === TradeOfferManager.ETradeOfferState.Expired) {
        sendDiscordNotification(`⌛ Trade Expired.\nBot: ${mafile.account_name}\nTrade ID: ${offer.id}\nPartner: https://steamcommunity.com/profiles/${partnerID}`);
      }
    });
  });

  client.on('error', err => {
    console.error(`[!] Login error for ${mafile.account_name}:`, err);
    sendDiscordNotification(`❌ Failed to login ${mafile.account_name}: ${err.message}`);
  });
}

app.post('/upload-mafile', upload.single('mafile'), (req, res) => {
  const filePath = path.join(__dirname, req.file.path);
  try {
    loginBot(filePath);
    res.json({ success: true, message: 'Bot login initiated.' });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.get('/bots', (req, res) => {
  const botList = Object.entries(bots).map(([steamID, data]) => ({
    steamID,
    account_name: data.mafile.account_name
  }));
  res.json(botList);
});

app.post('/send-trade', async (req, res) => {
  const { steamID, tradelink } = req.body;
  const bot = bots[steamID];

  if (!bot) return res.status(400).json({ error: 'Bot not found or not logged in.' });

  try {
    const [_, token] = tradelink.match(/token=([a-zA-Z0-9-_]+)/) || [];
    const [__, partner] = tradelink.match(/partner=([0-9]+)/) || [];
    const partnerSteamID = SteamUser.SteamID.fromIndividualAccountID(partner).getSteamID64();

    bot.manager.getInventoryContents(440, 2, true, async (err, inventory) => {
      if (err) return res.status(500).json({ error: 'Failed to load inventory.' });

      const pricesRes = await axios.get(`https://backpack.tf/api/IGetPrices/v4/?key=${BACKPACK_API_KEY}`);
      const prices = pricesRes.data.response.items;

      const tf2Items = inventory.filter(item => item.market_hash_name in prices);

      tf2Items.sort((a, b) => {
        const pa = prices[a.market_hash_name]?.value || 0;
        const pb = prices[b.market_hash_name]?.value || 0;
        return pb - pa;
      });

      const itemsToSend = tf2Items.slice(0, 49);
      const offer = bot.manager.createOffer(tradelink);
      offer.addMyItems(itemsToSend);
      offer.setMessage('Trade offer from automated TF2 bot.');

      offer.send((err, status) => {
        if (err) return res.status(500).json({ error: 'Failed to send trade offer.' });

        const itemList = formatItemList(itemsToSend);
        const value = formatTotalValue(itemsToSend, prices);
        sendDiscordNotification(
          `📤 Trade Sent!\nBot: ${bot.mafile.account_name}\nMafile: ${path.basename(bot.mafilePath)}\nTo: https://steamcommunity.com/profiles/${partnerSteamID}\nItems Offered: ${itemsToSend.length}\n\n💰 Total Value:\n- ${value.refined} ref\n- ${value.keys} keys\n- ~$${value.usd} USD\n\n**Items:**\n${itemList}`
        );
        res.json({ success: true, status });
      });
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

app.listen(PORT, () => {
  console.log(`✅ TF2 Trade Bot backend running on http://localhost:${PORT}`);
});
