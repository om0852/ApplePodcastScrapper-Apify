import { Actor } from 'apify';
import { PuppeteerCrawler } from 'crawlee';

/**
 * Apple Podcasts Episode Scraper
 * 
 * URL Pattern Analysis:
 * - Spaces in search terms are encoded as %20
 * - Example: "Giva jewellery" → "Giva%20jewellery"
 * - Example: "Giva" → "Giva"
 * - Pattern: https://podcasts.apple.com/in/search?term={ENCODED_TERM}
 */

await Actor.init();

try {
    // Get input from Apify Actor input
    const input = await Actor.getInput();
    const searchTerm = input?.searchTerm || 'Giva';
    const totalEpisodes = input?.totalEpisodes || 50; // Default to 50 episodes
    
    // URL encode the search term (spaces become %20)
    const encodedSearchTerm = encodeURIComponent(searchTerm);
    const searchUrl = `https://podcasts.apple.com/in/search?term=${encodedSearchTerm}`;
    
    console.log(`Starting scrape for search term: "${searchTerm}"`);
    console.log(`Target episodes to scrape: ${totalEpisodes}`);
    console.log(`Target URL: ${searchUrl}`);

    // Configure Apify proxy (rotates IPs automatically)
    const proxyConfiguration = await Actor.createProxyConfiguration({
        groups: ['RESIDENTIAL'], // Use residential proxies for better success
        countryCode: 'IN', // India region to match the URL
    });

    // Initialize Puppeteer crawler
    const crawler = new PuppeteerCrawler({
        proxyConfiguration,
        
        // Launch options for better stability
        launchContext: {
            launchOptions: {
                headless: true,
                args: [
                    '--no-sandbox',
                    '--disable-setuid-sandbox',
                    '--disable-dev-shm-usage',
                    '--disable-accelerated-2d-canvas',
                    '--disable-gpu',
                ],
            },
        },

        // Request handler - main scraping logic
        async requestHandler({ page, request, log }) {
            log.info(`Processing: ${request.url}`);

            try {
                // Step 1: Navigate to search URL and wait for content
                await page.goto(searchUrl, { 
                    waitUntil: 'networkidle2',
                    timeout: 60000 
                });
                
                log.info('Page loaded successfully');
                
                // Wait extra time for JavaScript to render content
                await new Promise(resolve => setTimeout(resolve, 3000));

                // Step 2: Wait for search results or header wrapper to appear
                // Try multiple selectors since Apple Podcasts structure may vary
                try {
                    await page.waitForSelector('[data-testid="search-results"], .header-title-wrapper', { 
                        timeout: 15000 
                    });
                    log.info('Search results or header wrapper loaded');
                } catch (waitError) {
                    log.warning(`Could not find search-results or header-wrapper: ${waitError.message}`);
                    // Continue anyway - we'll check for the header button next
                }

                // Step 3: Click on the "Episodes" header to open dialog box
                // Target the specific component: <div class="header-title-wrapper">
                try {
                    const headerClicked = await page.evaluate(() => {
                        // First, try to find the exact component structure
                        const headerWrapper = document.querySelector('.header-title-wrapper');
                        
                        if (headerWrapper) {
                            // Find the button with role="link" inside header-title-wrapper
                            const button = headerWrapper.querySelector('.title__button[role="link"]');
                            if (button) {
                                button.click();
                                return { success: true, method: 'exact-selector' };
                            }
                            
                            // Fallback: find any button in the header wrapper
                            const anyButton = headerWrapper.querySelector('button');
                            if (anyButton) {
                                anyButton.click();
                                return { success: true, method: 'any-button-in-wrapper' };
                            }
                        }
                        
                        // Alternative: Look for button with text "Episodes"
                        const buttons = Array.from(document.querySelectorAll('button'));
                        const episodesButton = buttons.find(btn => 
                            btn.textContent.toLowerCase().includes('episode') ||
                            btn.querySelector('.dir-wrapper')?.textContent.toLowerCase().includes('episode')
                        );
                        
                        if (episodesButton) {
                            episodesButton.click();
                            return { success: true, method: 'text-search' };
                        }
                        
                        return { success: false, method: 'none' };
                    });

                    if (headerClicked.success) {
                        log.info(`Successfully clicked Episodes header button (method: ${headerClicked.method})`);
                        
                        // Wait for dialog to open and render
                        await new Promise(resolve => setTimeout(resolve, 2000));
                        
                        // Additional wait for any modal/dialog to appear
                        try {
                            await page.waitForSelector('[role="dialog"], .modal, .dialog-box, .popup', { 
                                timeout: 10000 
                            });
                            log.info('Dialog box opened successfully');
                        } catch (dialogWaitError) {
                            log.warning('Dialog box selector not found, but continuing scraping');
                        }
                    } else {
                        log.warning('Could not find Episodes header button to click - this may be normal if episodes are already displayed');
                    }
                } catch (headerClickError) {
                    log.warning(`Error clicking Episodes header: ${headerClickError.message}`);
                }

                // Step 4: Extract episode data
                log.info('Extracting episode data...');
                
                    // Scroll the episodes list (if present) to load more items before extracting.
                    // The evaluate function runs in the page context and will try to scroll until
                    // we have collected `limit` items or reach a reasonable attempt cap.
                    const episodes = await page.evaluate(async (limit) => {
                        const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
                        const results = [];

                        const getRows = () => Array.from(document.querySelectorAll('ol[data-testid="episodes-list"] > li'));

                        let prevCount = 0;
                        let stableAttempts = 0;
                        const maxStableAttempts = 12; // stop if nothing new after ~12 tries

                        while (results.length < limit && stableAttempts < maxStableAttempts) {
                            const rows = getRows();

                            for (const row of rows) {
                                if (results.length >= limit) break;
                                try {
                                    const titleEl = row.querySelector('span.episode-details__title-text[data-testid="episode-lockup-title"]');
                                    const title = titleEl ? titleEl.textContent.trim() : null;

                                    const descEl = row.querySelector('div.episode-details__summary[data-testid="episode-content__summary"]');
                                    const description = descEl ? descEl.textContent.trim() : null;

                                    const dateEl = row.querySelector('p.episode-details__published-date[data-testid="episode-details__published-date"]');
                                    const date = dateEl ? dateEl.textContent.trim() : null;

                                    const linkEl = row.querySelector('a[data-testid="click-action"]');
                                    const shareUrl = linkEl ? linkEl.href : null;

                                    if (title) {
                                        // Avoid duplicates by checking last pushed title
                                        const last = results.length ? results[results.length - 1].title : null;
                                        if (title !== last) {
                                            results.push({ title, description, date, shareUrl });
                                        }
                                    }
                                } catch (e) {
                                    // ignore individual row errors
                                }
                            }

                            // If we collected more rows than previous iteration, reset stableAttempts
                            const currentCount = getRows().length;
                            if (currentCount > prevCount) {
                                prevCount = currentCount;
                                stableAttempts = 0;
                            } else {
                                stableAttempts += 1;
                            }

                            if (results.length >= limit) break;

                            // Scroll the last row into view to trigger lazy loading, or scroll the page as fallback
                            if (currentCount > 0) {
                                const lastRow = getRows()[currentCount - 1];
                                try { lastRow.scrollIntoView({ behavior: 'smooth', block: 'end' }); } catch (e) { window.scrollBy(0, window.innerHeight); }
                            } else {
                                window.scrollBy(0, window.innerHeight);
                            }

                            // Give time for new items to load
                            await sleep(800);
                        }

                        return results.slice(0, limit);
                    }, totalEpisodes);

                log.info(`Extracted ${episodes.length} episodes (requested: ${totalEpisodes})`);

                // Step 5: Normalize dates and save results to Apify dataset
                const normalizeDate = (raw) => {
                    if (!raw || typeof raw !== 'string') return { full: raw, iso: null };

                    const months = {
                        JAN: 0, FEB: 1, MAR: 2, APR: 3, MAY: 4, JUN: 5,
                        JUL: 6, AUG: 7, SEP: 8, OCT: 9, NOV: 10, DEC: 11,
                    };

                    const s = raw.replace(/,/g, '').trim().toUpperCase();

                    // Handle relative dates like "1 DAY AGO", "2 DAYS AGO", "1 HOUR AGO"
                    const relativeMatch = s.match(/^(\d+)\s+(SECOND|MINUTE|HOUR|DAY|WEEK|MONTH|YEAR)S?\s+AGO$/i);
                    if (relativeMatch) {
                        const amount = parseInt(relativeMatch[1], 10);
                        const unit = relativeMatch[2].toUpperCase();
                        const now = new Date();

                        // Subtract the amount from current date
                        switch (unit) {
                            case 'SECOND': now.setSeconds(now.getSeconds() - amount); break;
                            case 'MINUTE': now.setMinutes(now.getMinutes() - amount); break;
                            case 'HOUR': now.setHours(now.getHours() - amount); break;
                            case 'DAY': now.setDate(now.getDate() - amount); break;
                            case 'WEEK': now.setDate(now.getDate() - (amount * 7)); break;
                            case 'MONTH': now.setMonth(now.getMonth() - amount); break;
                            case 'YEAR': now.setFullYear(now.getFullYear() - amount); break;
                        }

                        const full = now.toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' });
                        const iso = now.toISOString().slice(0, 10);
                        return { full, iso };
                    }

                    // Handle absolute dates like "14 NOV", "14 Nov", "Nov 14", etc.
                    const parts = s.split(/\s+/);
                    let day = null;
                    let month = null;
                    let year = null;

                    // Pattern 1: Day Month [Year] -> ["14","NOV","2024"]
                    if (parts.length >= 2 && /^\d{1,2}$/.test(parts[0])) {
                        day = parseInt(parts[0], 10);
                        const m = parts[1].slice(0, 3);
                        if (months.hasOwnProperty(m)) month = months[m];
                        if (parts.length >= 3 && /^\d{4}$/.test(parts[2])) year = parseInt(parts[2], 10);
                    } else if (parts.length >= 2 && /^\d{1,2}$/.test(parts[1])) {
                        // Pattern 2: Month Day [Year] -> ["NOV","14","2024"]
                        const m = parts[0].slice(0, 3);
                        if (months.hasOwnProperty(m)) month = months[m];
                        day = parseInt(parts[1], 10);
                        if (parts.length >= 3 && /^\d{4}$/.test(parts[2])) year = parseInt(parts[2], 10);
                    }

                    let dateObj = null;
                    if (month !== null && day !== null) {
                        const now = new Date();
                        const candidateYear = year || now.getFullYear();
                        dateObj = new Date(candidateYear, month, day);

                        // If candidate is in future, assume previous year
                        if (!year && dateObj > now) {
                            dateObj = new Date(candidateYear - 1, month, day);
                        }
                    } else {
                        const parsed = Date.parse(s);
                        if (!isNaN(parsed)) dateObj = new Date(parsed);
                    }

                    if (!dateObj || isNaN(dateObj.getTime())) {
                        return { full: raw, iso: null };
                    }

                    const full = dateObj.toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' });
                    const iso = dateObj.toISOString().slice(0, 10);
                    return { full, iso };
                };

                if (episodes.length > 0) {
                    const normalized = episodes.map((ep) => {
                        const parsed = normalizeDate(ep.date);
                        return { ...ep, date: parsed.full, dateISO: parsed.iso };
                    });

                    await Actor.pushData(normalized);
                    log.info(`Successfully saved ${normalized.length} episodes to dataset`);
                } else {
                    log.warning('No episodes found - check if selectors are correct or if content loaded properly');
                    
                    // Debug: Save page screenshot and HTML
                    await Actor.setValue('debug_screenshot.png', await page.screenshot(), { 
                        contentType: 'image/png' 
                    });
                    await Actor.setValue('debug_page.html', await page.content(), { 
                        contentType: 'text/html' 
                    });
                    log.info('Saved debug screenshot and HTML for inspection');
                }

            } catch (error) {
                log.error(`Error during scraping: ${error.message}`);
                
                // Save debug information on error
                try {
                    await Actor.setValue('error_screenshot.png', await page.screenshot(), { 
                        contentType: 'image/png' 
                    });
                    await Actor.setValue('error_page.html', await page.content(), { 
                        contentType: 'text/html' 
                    });
                } catch (debugError) {
                    log.error(`Could not save debug info: ${debugError.message}`);
                }
                
                throw error;
            }
        },

        // Error handler
        failedRequestHandler({ request, log }, error) {
            log.error(`Request ${request.url} failed multiple times`, { error });
        },

        // Max retries for failed requests
        maxRequestRetries: 3,
        
        // Concurrency settings
        maxConcurrency: 1, // Process one page at a time for stability
    });

    // Add the initial URL to the request queue
    await crawler.addRequests([{
        url: searchUrl,
        userData: { label: 'SEARCH' },
    }]);

    // Run the crawler
    await crawler.run();

    console.log('Scraping completed successfully!');

} catch (error) {
    console.error('Fatal error:', error);
    throw error;
} finally {
    await Actor.exit();
}

/**
 * INPUT SCHEMA (for Apify Actor):
 * {
 *   "searchTerm": "Giva jewellery",
 *   "totalEpisodes": 50
 * }
 * 
 * OUTPUT FORMAT:
 * [
 *   {
 *     "title": "Episode Title",
 *     "description": "Episode description text...",
 *     "date": "Jan 15, 2024",
 *     "shareUrl": "https://podcasts.apple.com/in/podcast/..."
 *   }
 * ]
 */