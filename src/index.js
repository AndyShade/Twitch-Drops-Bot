'use strict';

const fs = require('fs');
const path = require('path');

const logger = require('./logger');
const twitch = require('./twitch');
const {StringOption, BooleanOption, IntegerOption, ListOption} = require('./options');
const {TwitchDropsBot} = require('./twitch_drops_bot');
const {ConfigurationParser} = require('./configuration_parser');

// Using puppeteer-extra to add plugins
const puppeteer = require('puppeteer-extra');

// Add stealth plugin
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
puppeteer.use(StealthPlugin());

function onBrowserOrPageClosed() {
    logger.info('Browser was disconnected or tab was closed! Exiting...');
    process.exit(1);
}

function getUsernameFromCookies(cookies) {
    for (const cookie of cookies) {
        if (cookie['name'] === 'name' || cookie['name'] === 'login') {
            return cookie['value'];
        }
    }
}

function areCookiesValid(cookies) {
    let isOauthTokenFound = false;
    for (const cookie of cookies) {
        // Check if we have an OAuth token
        if (cookie['name'] === 'auth-token') {
            isOauthTokenFound = true;
        }
    }
    return isOauthTokenFound;
}

// Options defined here can be configured in either the config file or as command-line arguments
const options = [
    new StringOption('--username', '-u'),
    new StringOption('--password', '-p'),
    new StringOption('--browser', '-b', () => {
        switch (process.platform) {
            case "win32":
                return path.join("C:", "Program Files (x86)", "Google", "Chrome", "Application", "chrome.exe");

            case "linux":
                return path.join("google-chrome");

            default:
                return '';
        }
    }),
    new ListOption('--games', '-g', []),
    new BooleanOption('--headless', null, true, false),
    new BooleanOption('--headless-login', null, false),
    new IntegerOption('--interval', '-i', 15),
    new ListOption('--browser-args', null, []),
    new BooleanOption('--update-games', null, false),
    new BooleanOption('--watch-unlisted-games', null, false),
    new StringOption('--cookies-path'),
    new StringOption('--log-level')
];

// Parse arguments
const configurationParser = new ConfigurationParser(options);
let config = configurationParser.parse();

// Set logging level
if (config['log_level']) {
    // TODO: validate input
    logger.level = config['log_level'];
}

// Add required browser args
const requiredBrowserArgs = [
    '--mute-audio',
    '--disable-background-timer-throttling',
    '--disable-backgrounding-occluded-windows',
    '--disable-renderer-backgrounding',
    '--window-size=1920,1080'
]
for (const arg of requiredBrowserArgs) {
    if (!config['browser_args'].includes(arg)) {
        config['browser_args'].push(arg);
    }
}

// Make username lowercase
if (config['username']) {
    config['username'] = config['username'].toLowerCase();
}

(async () => {

    // Start browser and open a new tab.
    const browser = await puppeteer.launch({
        headless: config['headless'],
        executablePath: config['browser'],
        args: config['browser_args']
    });
    const page = await browser.newPage();

    // Automatically stop this program if the browser or page is closed
    browser.on('disconnected', onBrowserOrPageClosed);
    page.on('close', onBrowserOrPageClosed);

    // Check if we have saved cookies
    let cookiesPath = config['cookies_path'] || (config['username'] ? `./cookies-${config['username']}.json` : null);
    let requireLogin = false;
    if (fs.existsSync(cookiesPath)) {

        // Load cookies
        const cookies = JSON.parse(fs.readFileSync(cookiesPath, 'utf-8'));

        // Make sure these cookies are valid
        if (areCookiesValid(cookies)) {

            // If both cookies and a username are provided and the provided username does not match the username stored in the cookies, warn the user and prefer to use the one from the cookies.
            const username = config['username'];
            if (username && (username !== getUsernameFromCookies(cookies))) {
                logger.warn('Provided username does not match the one found in the cookies! Using the cookies to login...');
            }

            // Restore cookies from previous session
            logger.info('Restoring cookies from last session.');
            await page.setCookie(...cookies);

        } else {

            // Saved cookies are invalid, let's delete them
            logger.info('Saved cookies are invalid.')
            fs.unlinkSync(cookiesPath);

            // We need to login again
            requireLogin = true;

        }

    } else {
        requireLogin = true;
    }

    let cookies = null;
    if (requireLogin) {
        logger.info('Logging in...');

        // Validate options
        if (config['headless_login'] && (config['username'] === undefined || config['password'] === undefined)) {
            parser.error("You must provide a username and password to use headless login!");
            process.exit(1);
        }

        // Check if we need to create a new headful browser for the login
        const needNewBrowser = config['headless'] && !config['headless_login'];
        let loginBrowser = browser;
        if (needNewBrowser) {
            loginBrowser = await puppeteer.launch({
                headless: false,
                executablePath: config['browser'],
                args: config['browser_args']
            });
        }

        cookies = await twitch.login(loginBrowser, config['username'], config['password'], config['headless_login']);
        await page.setCookie(...cookies);

        if (needNewBrowser) {
            await loginBrowser.close();
        }
    }

    // Twitch credentials for API interactions
    const twitchCredentials = {

        // Seems to be the default hard-coded client ID
        // Found in sources / static.twitchcdn.net / assets / minimal-cc607a041bc4ae8d6723.js
        'client_id': 'kimne78kx3ncx6brgo4mv6wki5h1ko'

    }

    // Get some data from the cookies
    for (const cookie of await page.cookies('https://www.twitch.tv')) {
        switch (cookie['name']) {
            case 'auth-token':  // OAuth token
                twitchCredentials['oauth_token'] = cookie['value'];
                break;

            case 'persistent':  // "channelLogin" Used for "DropCampaignDetails" operation
                twitchCredentials['channel_login'] = cookie['value'].split('%3A')[0];
                break;

            case 'login':
                config['username'] = cookie['value'];
                logger.info('Logged in as ' + cookie['value']);
                break;
        }
    }

    // Save cookies
    if (requireLogin) {
        cookiesPath = `./cookies-${config['username']}.json`;
        fs.writeFileSync(cookiesPath, JSON.stringify(cookies));
        logger.info('Saved cookies to ' + cookiesPath);
    }

    const twitchClient = new twitch.Client(twitchCredentials['client_id'], twitchCredentials['oauth_token'], twitchCredentials['channel_login']);

    const bot = new TwitchDropsBot(config, page, twitchClient);
    await bot.start();

})().catch(error => {
    logger.error(error);
    process.exit(1);
});
