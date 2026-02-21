/**
 * Customer list manager
 * Saves every new private contact that messages the bot.
 * Data stored in config/customers.json
 */

const fs   = require('fs');
const path = require('path');

const FILE = path.join(__dirname, '..', 'config', 'customers.json');

function load() {
    try {
        return JSON.parse(fs.readFileSync(FILE, 'utf8'));
    } catch (e) {
        return {};
    }
}

function save(data) {
    try {
        fs.writeFileSync(FILE, JSON.stringify(data, null, 2));
    } catch (e) {
        console.error('[CUSTOMERS] Failed to save:', e.message);
    }
}

/**
 * Record a contact the first time they message.
 * @param {string} contactId  — msg.from  e.g. 2771234@c.us
 * @param {string} name       — contact display name (may be empty)
 */
function recordCustomer(contactId, name) {
    const data = load();
    if (data[contactId]) return null; // already known
    const code = 'WELCOME-' + Math.random().toString(36).substr(2, 6).toUpperCase();
    const customer = {
        id:           contactId,
        name:         name || '',
        firstSeen:    new Date().toISOString(),
        lastSeen:     new Date().toISOString(),
        discountCode: code,
        welcomeSent:  false,
    };
    data[contactId] = customer;
    save(data);
    console.log(`[CUSTOMERS] New customer saved: ${name || contactId}`);
    return customer; // caller can send welcome message
}

/**
 * Update lastSeen timestamp for a known customer.
 */
function touchCustomer(contactId) {
    const data = load();
    if (!data[contactId]) return;
    data[contactId].lastSeen = new Date().toISOString();
    save(data);
}

/**
 * Mark that the welcome message has been sent to this customer.
 */
function markWelcomeSent(contactId) {
    const data = load();
    if (!data[contactId]) return;
    data[contactId].welcomeSent = true;
    save(data);
}

/**
 * Return array of all customer objects.
 */
function getAllCustomers() {
    return Object.values(load());
}

module.exports = { recordCustomer, touchCustomer, getAllCustomers, markWelcomeSent };
