require('dotenv').config();
const express = require('express');
const { Client } = require('@notionhq/client');

const app = express();
app.use(express.json());

// Initialize the Notion client using the token from .env
const notion = new Client({ auth: process.env.NOTION_TOKEN });

// ID of the Notion meetings database, configured in .env
const MEETINGS_DB_ID = process.env.NOTION_MEETINGS_DATABASE_ID;

/**
 * Fetch meetings from Notion using paginated queries.
 * 
 * @param {string} databaseId - The ID of the database to query.
 * @param {object} queryOptions - Additional options (filter, sorts, etc.) to pass to the Notion API.
 * @returns {Promise<object[]>} - Returns all matching pages across all pages of results.
 */
async function fetchMeetings(databaseId, queryOptions = {}) {
  let results = [];
  let hasMore = true;
  let startCursor;

  // Loop through all pages of results until there are no more.
  while (hasMore) {
    const response = await notion.databases.query({
      database_id: databaseId,
      start_cursor: startCursor,
      ...queryOptions,
    });
    
    results.push(...response.results);
    hasMore = response.has_more;
    startCursor = response.next_cursor;
  }
  return results;
}

/**
 * Sets "Previous Meeting" and "Next Meeting" relations on a given page
 * based on its location within a sorted list of pages.
 * 
 * @param {string} pageId - The ID of the page to update.
 * @param {object[]} pages - A sorted list of pages (by ascending date).
 */
async function setPrevNextRelations(pageId, pages) {
  // Find the index of the triggered page in our list
  const pageIndex = pages.findIndex((p) => p.id === pageId);
  if (pageIndex === -1) {
    console.log('Triggered page not found in the provided list.');
    return;
  }

  // Identify the previous and next page IDs (if they exist in the list)
  const previousId = pageIndex > 0 ? pages[pageIndex - 1].id : null;
  const nextId = pageIndex < pages.length - 1 ? pages[pageIndex + 1].id : null;

  // Update the Notion page to reflect the newly determined relations
  await notion.pages.update({
    page_id: pageId,
    properties: {
      'Previous Meeting': { relation: previousId ? [{ id: previousId }] : [] },
      'Next Meeting': { relation: nextId ? [{ id: nextId }] : [] },
    },
  });

  console.log(`Updated page ${pageId} → Previous: ${previousId}, Next: ${nextId}`);
}

/**
 * POST /api/notion-meetings-webhook
 * Main endpoint to handle Notion webhook events for meeting pages.
 *
 * - Distinguishes between 1:1 meetings (exactly 1 attendee) and recurring group meetings.
 * - Sets "Previous Meeting" / "Next Meeting" relations for the triggered page, 
 *   based on the meeting type and a sorted list of pages.
 */
app.post('/api/notion-meetings-webhook', async (req, res) => {
  try {
    // The page ID that triggered this webhook
    const pageId = req.body?.data?.id;
    if (!pageId) {
      console.error('No page ID found in the webhook payload.');
      return res.status(400).send({ error: 'Missing page ID.' });
    }

    console.log('Webhook received for page ID:', pageId);

    // Retrieve the full page object from Notion
    const page = await notion.pages.retrieve({ page_id: pageId });

    // Extract the relevant properties
    const { People, Meeting } = page?.properties || {};
    const attendees = People?.relation || [];
    const meetingTitle = Meeting?.title?.[0]?.plain_text;

    // Decide how to filter meetings based on the number of attendees
    if (attendees.length === 1) {
      console.log('Detected a 1:1 meeting');
      
      // Fetch all 1:1-type meetings sorted by date
      const allMeetings = await fetchMeetings(MEETINGS_DB_ID, {
        sorts: [{ property: 'Date', direction: 'ascending' }],
      });

      // Filter down to meetings that have exactly the same single attendee
      const attendeeId = attendees[0].id;
      const filtered = allMeetings.filter((p) => {
        const pAttendees = p.properties?.People?.relation || [];
        return pAttendees.length === 1 && pAttendees[0].id === attendeeId;
      });

      await setPrevNextRelations(pageId, filtered);
    } else {
      console.log('Detected a recurring group meeting');
      
      // If no meeting title exists, it's impossible to group them
      if (!meetingTitle) {
        console.log('No valid title found for this group meeting. Skipping relation updates.');
        return res.status(200).send({ success: true });
      }

      // Fetch all group meetings sharing the same title, sorted by date
      const grouped = await fetchMeetings(MEETINGS_DB_ID, {
        filter: {
          property: 'Meeting',
          title: { equals: meetingTitle },
        },
        sorts: [{ property: 'Date', direction: 'ascending' }],
      });

      await setPrevNextRelations(pageId, grouped);
    }

    return res.status(200).send({ success: true });
  } catch (error) {
    console.error('Error handling webhook:', error);
    return res.status(500).send({ error: 'Internal Server Error' });
  }
});

module.exports = app;
