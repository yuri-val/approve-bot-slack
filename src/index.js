require('dotenv').config();

const express = require('express');
const bodyParser = require('body-parser');
const api = require('./api');
const payloads = require('./payloads');
const signature = require('./verifySignature');

const low = require('lowdb')
const FileSync = require('lowdb/adapters/FileSync')

const adapter = new FileSync('db/file_db.json');
const db = low(adapter);

db.defaults({ orders: [], approvings: [], users: []}).write()

const app = express();

/*
 * Parse application/x-www-form-urlencoded && application/json
 * Use body-parser's `verify` callback to export a parsed raw body
 * that you need to use to verify the signature
 */

const rawBodyBuffer = (req, res, buf, encoding) => {
  if (buf && buf.length) {
    req.rawBody = buf.toString(encoding || 'utf8');
  }
};

app.use(bodyParser.urlencoded({ verify: rawBodyBuffer, extended: true }));
app.use(bodyParser.json({ verify: rawBodyBuffer }));

app.get('/', (req, res) => {
  res.send('<h2>The Approval Flow app is running</h2> <p>Follow the' +
    ' instructions in the README to configure the Slack App and your' +
    ' environment variables.</p>');
});

/*
 * Endpoint to receive events from Slack's Events API.
 * It handles `message.im` event callbacks.
 */

app.post('/events', (req, res) => {
  switch (req.body.type) {
    case 'url_verification': {
      // verify Events API endpoint by returning challenge if present
      return res.send({ challenge: req.body.challenge });
    }
    case 'event_callback': {
      // Verify the signing secret
      if (!signature.isVerified(req)) return res.status(400).send();

      const event = req.body.event;
      // ignore events from bots
      if (event.bot_id) return res.status(200).send();

      handleEvent(event);
      return res.status(200).send();
    }
    default:
      return res.status(404).send();
  }
});

/*
 * Endpoint to receive events from interactive message and a dialog on Slack. 
 * Verify the signing secret before continuing.
 */
app.post('/interactions', async (req, res) => {
  if (!signature.isVerified(req)) return res.status(400).send();

  const payload = JSON.parse(req.body.payload);
  
  db.get('users').find({id: payload.user.id}).assign(payload.user).write();

  if (payload.type === 'block_actions') {
    // acknowledge the event before doing heavy-lifting on our servers
    res.status(200).send();

    let action = payload.actions[0]
    
    console.log('payload:', payload);
    console.log('action:', action);
    

    switch (action.action_id) {
      case 'make_announcement':
        // await api.openRequestModal(payload.trigger_id);
        await api.callAPIMethodPost('views.open', {
          trigger_id: payload.trigger_id,
          view: payloads.request_announcement()
        });
        break;
      case 'dismiss':
        await api.callAPIMethodPost('chat.delete', {
          channel: payload.channel.id,
          ts: payload.message.ts
        });
        break;
      case 'approve':
        const data_approve = JSON.parse(action.value);
        await api.postAnnouncement(payload, data_approve);
        db.get('approvings').push({id: ID(), order_id: data_approve.id, user_id: payload.user.id, action: action.action_id});
        break;
      case 'reject':
        const data_reject = JSON.parse(action.value);
        await api.rejectAnnouncement(payload, data_reject);
        db.get('approvings').push({id: ID(), order_id: data_reject.id, user_id: payload.user.id, action: action.action_id});
        break;
    }
  } else if (payload.type === 'view_submission') {
    return handleViewSubmission(payload, res);
  }

  return res.status(404).send();

});

/*
 * Endpoint to receive events from interactive message and a dialog on Slack.
 * Verify the signing secret before continuing.
 */
app.post('/options', async (req, res) => {
  if (!signature.isVerified(req)) return res.status(400).send();
  const payload = JSON.parse(req.body.payload);

  let botUser = await api.callAPIMethodPost('auth.test', {})
  let conversations = await api.getChannels(botUser.user_id)
  let options = conversations.map(c => {
    return {
      text: {
        type: 'plain_text',
        text: c.name
      },
      value: c.id
    }
  })

  options = options.filter(option => {
    return option.text.text.indexOf(payload.value) >= 0
  })

  return res.send({
    options: options
  })
})


/**
 * Handle all incoming events from the Events API
 */
const handleEvent = async (event) => {
  switch (event.type) {
    case 'app_home_opened':
      if (event.tab === 'messages') {
        // only send initial message for the first time users opens the messages tab,
        // we can check for that by requesting the message history
        let history = await api.callAPIMethodGet('im.history', {
          channel: event.channel,
          count: 1
        })

        if (!history.messages.length) await api.callAPIMethodPost('chat.postMessage', payloads.welcome_message({
          channel: event.channel
        }));
      } else if (event.tab === 'home') {
        await api.callAPIMethodPost('views.publish', {
          user_id: event.user,
          view: payloads.welcome_home()
        });
      }
      break;
    case 'message':
      // only respond to new messages posted by user, those won't carry a subtype
      if (!event.subtype) {
        await api.callAPIMethodPost('chat.postMessage', payloads.welcome_message({
          channel: event.channel
        }));
      }
      break;
  }
}

const ID = () => {
  // Math.random should be unique because of its seeding algorithm.
  // Convert it to base 36 (numbers + letters), and grab the first 9 characters
  // after the decimal.
  return '_' + Math.random().toString(36).substr(2, 9);
};

/**
 * Handle all Block Kit Modal submissions
 */
const handleViewSubmission = async (payload, res) => {
  switch (payload.view.callback_id) {
    case 'request_announcement':
      const values = payload.view.state.values;
      
      let approvers = values.approver.approver_id.selected_users;
      let approverString = approvers.map(user => `<@${user}>`).join(', ')
      
      let channels = values.channel.channel_id.selected_options.map(channel => channel.value);
      let channelString = channels.map(channel => `<#${channel}>`).join(', ');

      // respond with a stacked modal to the user to confirm selection
      let announcement = {
        id: ID(),
        title: values.title.title_id.value,
        details: values.details.details_id.value,
        approvers: approvers,
        approverString: approverString,
        channels: channels,
        channelString: channelString
      }
      return res.send(payloads.confirm_announcement({
        announcement
      }));
    case 'confirm_announcement':
      const data = JSON.parse(payload.view.private_metadata);
      await api.requestAnnouncement(payload.user, data);
      db.get('orders').push(data).write();
      // show a final confirmation modal that the request has been sent
      return res.send(payloads.finish_announcement());
  }
}


const server = app.listen(process.env.PORT || 5000, () => {
  console.log('Express server listening on port %d in %s mode', server.address().port, app.settings.env);
});