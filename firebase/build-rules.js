'use strict';

/*
 * Builds database.rules.json (Firebase Realtime Database security rules).
 * The rules language has no functions, so shared conditions are composed here.
 * Run: node firebase/build-rules.js
 */

const fs = require('fs');
const path = require('path');

const signedIn = 'auth != null';
const isUser = "(auth != null && root.child('users/' + auth.uid + '/role').exists())";
const isOwner = "(auth != null && root.child('users/' + auth.uid + '/role').val() === 'owner')";
const isPc = (pc) => `(auth != null && root.child('pcs/' + ${pc} + '/uid').val() === auth.uid)`;
const ownerDeletes = `(${isOwner} && !newData.exists())`;
const pcDeletes = (pc) => `(${isPc(pc)} && !newData.exists())`;
const ROLE = "(newData.child('role').val() === 'owner' || newData.child('role').val() === 'client')";
const inv = "root.child('invites/' + newData.child('invite').val())";
const code = "newData.child('code').val()";
const UNCHANGED = (keys) => keys.map((k) => `newData.child('${k}').val() === data.child('${k}').val()`).join(' && ');
const ACTIONS = 'startStream|endStream|cancel|confirmLive|openZoom|shareImage|shareScreen|stopShare|nextImage|dismissError|selectImage|setSchedule';

const rules = {
  rules: {
    '.read': false,
    '.write': false,

    // Set once in the Firebase console (Realtime Database -> Data). Nobody can read it through the website.
    secrets: { '.read': false, '.write': false },

    // The owner claims the site once, with the setup code stored in /secrets/setupCode.
    owner: {
      '.write': `${signedIn} && !data.exists()`,
      '.validate':
        "newData.hasChildren(['uid', 'code']) && newData.child('uid').val() === auth.uid && root.child('secrets/setupCode').isString() && root.child('secrets/setupCode').val().length >= 8 && newData.child('code').val() === root.child('secrets/setupCode').val()",
      uid: { '.read': true },
    },

    users: {
      '.read': isOwner,
      $uid: {
        '.read': `${signedIn} && auth.uid === $uid`,
        // Owner: change the role of, or remove, someone else. Anyone signed in: create their own record once
        // (as owner together with the owner claim, or as invited).
        '.write': `(${isOwner} && $uid !== auth.uid && data.exists()) || (${signedIn} && $uid === auth.uid && !data.exists())`,
        '.validate': [
          `newData.hasChildren(['email', 'role', 'createdAt']) && ${ROLE} && (data.exists()`,
          "? (newData.child('email').val() === data.child('email').val() && newData.child('createdAt').val() === data.child('createdAt').val())",
          ": (auth.token.email != null && newData.child('email').val() === auth.token.email.toLowerCase() && newData.child('createdAt').val() === now && (",
          "(newData.child('role').val() === 'owner' && newData.parent().parent().child('owner/uid').val() === auth.uid)",
          `|| (newData.child('invite').isString() && ${inv}.child('email').val() === auth.token.email.toLowerCase() && ${inv}.child('role').val() === newData.child('role').val() && ${inv}.child('expiresAt').val() > now && !${inv}.child('usedBy').exists() && newData.parent().parent().child('invites/' + newData.child('invite').val() + '/usedBy').val() === auth.uid)`,
          ')))',
        ].join(' '),
      },
    },

    invites: {
      '.read': isOwner,
      $token: {
        // Knowing the link's token is what lets someone open their invite.
        '.read': true,
        '.write': `${isOwner} && (!data.exists() || !newData.exists())`,
        // New invite: checked in full. Existing invite (only "usedBy" may be added): nothing else may change.
        '.validate': `data.exists() ? (${UNCHANGED(['email', 'role', 'createdBy', 'createdAt', 'expiresAt'])}) : ($token.length >= 24 && newData.hasChildren(['email', 'role', 'createdBy', 'createdAt', 'expiresAt']) && ${ROLE} && newData.child('createdBy').val() === auth.uid && newData.child('email').isString() && newData.child('email').val() === newData.child('email').val().toLowerCase() && newData.child('email').val().length <= 254 && newData.child('createdAt').val() === now && newData.child('expiresAt').isNumber() && newData.child('expiresAt').val() <= now + 7 * 86400000 + 60000 && !newData.child('usedBy').exists())`,
        usedBy: {
          '.write': `${signedIn} && !data.exists() && newData.val() === auth.uid && newData.parent().parent().parent().child('users/' + auth.uid + '/invite').val() === $token`,
        },
      },
    },

    // One-time codes for adding a PC (10 minutes).
    pairing: {
      $code: {
        '.write': `${isOwner} && (!data.exists() || !newData.exists())`,
        '.validate': `data.exists() ? (${UNCHANGED(['createdBy', 'expiresAt'])}) : ($code.matches(/^[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}$/) && newData.hasChildren(['createdBy', 'expiresAt']) && newData.child('createdBy').val() === auth.uid && newData.child('expiresAt').isNumber() && newData.child('expiresAt').val() <= now + 11 * 60000 && !newData.child('usedBy').exists())`,
        usedBy: {
          '.write': `${signedIn} && !data.exists() && root.child('pairing/' + $code + '/expiresAt').val() > now && newData.parent().parent().parent().child('pcs/' + newData.val() + '/uid').val() === auth.uid`,
        },
      },
    },

    pcs: {
      '.read': isUser,
      $pc: {
        '.read': isPc('$pc'),
        // A PC adds itself with a valid pairing code; the owner (or the PC itself, when unpaired) removes it.
        '.write': `${ownerDeletes} || ${pcDeletes('$pc')} || (${signedIn} && !data.exists() && newData.exists())`,
        '.validate': `$pc.length === 36 && newData.hasChildren(['name', 'uid', 'pairedAt', 'code']) && newData.child('uid').val() === auth.uid && newData.child('pairedAt').val() === now && newData.child('name').isString() && newData.child('name').val().length >= 1 && newData.child('name').val().length <= 60 && root.child('pairing/' + ${code} + '/expiresAt').val() > now && !root.child('pairing/' + ${code} + '/usedBy').exists() && newData.parent().parent().child('pairing/' + ${code} + '/usedBy').val() === $pc`,
      },
    },

    presence: {
      '.read': isUser,
      $pc: {
        '.write': `${isPc('$pc')} || ${ownerDeletes}`,
        '.validate': "newData.hasChildren(['online', 'lastSeen']) && newData.child('online').isBoolean() && newData.child('lastSeen').val() === now",
      },
    },
    state: {
      '.read': isUser,
      $pc: { '.write': `${isPc('$pc')} || ${ownerDeletes}` },
    },
    preview: {
      '.read': isUser,
      $pc: {
        '.write': `${isPc('$pc')} || ${ownerDeletes}`,
        '.validate':
          "newData.hasChildren(['name', 'dataUrl']) && newData.child('name').isString() && newData.child('dataUrl').isString() && newData.child('dataUrl').val().length <= 300000 && (newData.child('dataUrl').val() === '' || newData.child('dataUrl').val().beginsWith('data:image/jpeg;base64,'))",
      },
    },
    // Live screen: written by the PC only while someone is watching.
    frames: {
      $pc: {
        '.read': isUser,
        '.write': `${isPc('$pc')} || ${ownerDeletes}`,
        '.validate': "newData.hasChildren(['at', 'jpeg']) && newData.child('at').val() === now && newData.child('jpeg').isString() && newData.child('jpeg').val().length <= 600000",
      },
    },
    // Who is watching the live screen: watch/<pc>/<uid> = time, refreshed every 20 s.
    watch: {
      $pc: {
        '.read': `${isPc('$pc')} || ${isUser}`,
        '.write': `${ownerDeletes} || ${pcDeletes('$pc')}`,
        $uid: {
          '.write': `${isUser} && auth.uid === $uid && root.child('pcs/' + $pc).exists()`,
          '.validate': 'newData.val() === now',
        },
      },
    },

    // Buttons pressed on the website, picked up and removed by the PC.
    commands: {
      $pc: {
        '.read': isPc('$pc'),
        '.write': `${ownerDeletes} || ${pcDeletes('$pc')}`,
        $cmd: {
          '.write': `(${isUser} && !data.exists() && newData.exists() && root.child('pcs/' + $pc).exists()) || (!newData.exists() && (${isPc('$pc')} || data.child('uid').val() === auth.uid))`,
          '.validate': [
            "newData.hasChildren(['action', 'uid', 'by', 'at']) && newData.child('uid').val() === auth.uid && newData.child('by').val() === auth.token.email && newData.child('at').val() === now",
            `&& newData.child('action').isString() && newData.child('action').val().matches(/^(${ACTIONS})$/)`,
            "&& (newData.child('action').val() === 'selectImage' ? (newData.child('args/name').isString() && newData.child('args/name').val().length >= 1 && newData.child('args/name').val().length <= 260)",
            ": newData.child('action').val() === 'setSchedule' ? (newData.child('args/time').isString() && newData.child('args/time').val().matches(/^([01][0-9]|2[0-3]):[0-5][0-9]$/) && newData.child('args/enabled').isBoolean())",
            ": !newData.child('args').exists())",
          ].join(' '),
        },
      },
    },
    results: {
      $pc: {
        '.read': isUser,
        '.write': `${isPc('$pc')} || ${ownerDeletes}`,
        $cmd: {
          '.validate': "newData.hasChildren(['ok', 'at']) && newData.child('ok').isBoolean() && newData.child('at').val() === now",
        },
      },
    },

    // "Who did what" log: people add entries as themselves; only the owner reads it.
    audit: {
      '.read': isOwner,
      $id: {
        '.write': `${isUser} && !data.exists()`,
        '.validate':
          "newData.hasChildren(['at', 'actor', 'action']) && newData.child('at').val() === now && newData.child('actor').val() === auth.token.email && newData.child('action').isString() && newData.child('action').val().length <= 100 && (!newData.child('detail').exists() || (newData.child('detail').isString() && newData.child('detail').val().length <= 500))",
      },
    },
  },
};

const out = path.join(__dirname, '..', 'database.rules.json');
fs.writeFileSync(out, JSON.stringify(rules, null, 2) + '\n');
console.log(`Wrote ${path.relative(process.cwd(), out)}`);
