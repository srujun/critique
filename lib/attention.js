// Core attention set computation — pure function, no Chrome API dependency.

/**
 * Returns true if the user should be considered a bot.
 */
export function isBot(login, userObj) {
  if (!login) return false;
  if (login.includes('[bot]')) return true;
  if (userObj && userObj.type === 'Bot') return true;
  if (userObj && userObj.type === 'Organization') return true;

  if (/^\d+$/.test(login)) return true;
  if (userObj && userObj.type && userObj.type !== 'User') return true;
  return false;
}

// PR states
const STATE = {
  DRAFT: 'DRAFT',
  REVIEWING: 'REVIEWING',
  CHANGES_REQUESTED: 'CHANGES_REQUESTED',
  COMMENTED: 'COMMENTED',
  APPROVED_NO_AUTOMERGE: 'APPROVED_NO_AUTOMERGE',
  MERGING: 'MERGING',
  STALLED_MERGE: 'STALLED_MERGE',
  MERGED: 'MERGED',
  CLOSED: 'CLOSED',
};

const AUTO_MERGE_ON = new Set([
  'auto_merge_enabled',
  'auto_squash_enabled',
  'auto_rebase_enabled',
  'added_to_merge_queue',
]);
const AUTO_MERGE_OFF = new Set(['auto_merge_disabled', 'removed_from_merge_queue']);

// States where someone is expected to act. Drafts, merging, merged and closed PRs are nobody's turn.
export const isActiveState = (prState) => !['DRAFT', 'MERGING', 'MERGED', 'CLOSED'].includes(prState);

export function computeAttentionSet(
  timeline,
  me,
  author,
  debounceMin,
  now = Date.now(),
  {
    onlyDirectRequests = false,
    whitelistedTeams = [],
    // Pushes after review. headSha is the PR's current head commit; headChangedAt is when it last changed.
    headSha = null,
    headChangedAt = 0,
    pushReturnsTurn = false,
  } = {},
) {
  const debounceMs = debounceMin * 60 * 1000;
  const ciHas = (set, val) => {
    const lower = val.toLowerCase();
    for (const v of set) {
      if (v.toLowerCase() === lower) return true;
    }
    return false;
  };
  const TWENTY_FOUR_HOURS = 24 * 60 * 60 * 1000;

  // --- Step 1: Determine PR state ---
  let prState = STATE.REVIEWING; // default: waiting for review
  let autoMergeActive = false;
  let lastActivityAt = 0; // last non-bot event timestamp
  const requestedReviewers = new Set(); // track current requested reviewers
  const allReviewers = new Set(); // all users who ever reviewed or were requested
  const reviewerStates = {}; // reviewer -> 'pending' | 'approved' | 'changes_requested' | 'commented'
  let meAddedViaTeam = false; // whether me entered via team review request
  let meAddedDirectly = false; // whether me was directly requested
  let commentedAt = 0; // timestamp of the commented review (for debounce)

  // Additional tracking for attention set extras
  const mentioned = new Map(); // user -> { status, since }
  const assigned = new Set();
  const lastReview = {}; // reviewer -> { state, commitId } of their latest review

  for (const event of timeline) {
    const type = event.event || event.__type;
    const ts = new Date(event.created_at || event.submitted_at || 0).getTime();
    const actor = event.actor?.login || event.user?.login || '';
    const actorObj = event.actor || event.user;

    // Track last non-bot activity
    if (!isBot(actor, actorObj) && ts > lastActivityAt) {
      lastActivityAt = ts;
    }

    // Track auto-merge status
    if (AUTO_MERGE_ON.has(type)) autoMergeActive = true;
    if (AUTO_MERGE_OFF.has(type)) autoMergeActive = false;

    switch (type) {
      case 'convert_to_draft':
        prState = STATE.DRAFT;
        break;

      case 'ready_for_review':
        prState = STATE.REVIEWING;
        break;

      case 'review_requested': {
        const reviewer = event.requested_reviewer?.login;
        if (reviewer) {
          requestedReviewers.add(reviewer);
          allReviewers.add(reviewer);
          if (!reviewerStates[reviewer]) reviewerStates[reviewer] = 'pending';
          if (reviewer === me) meAddedDirectly = true;
        }
        // Team review request — track if me is implicitly involved
        const _team = event.requested_team?.name || event.requested_team?.slug;
        if (_team && !reviewer) {
          const teamAllowed = !onlyDirectRequests || whitelistedTeams.includes(_team);
          if (teamAllowed) {
            meAddedViaTeam = true;
          }
        }
        // If author re-requests review, transition to REVIEWING
        if (actor === author) {
          prState = STATE.REVIEWING;
        }
        break;
      }

      case 'review_request_removed': {
        const removed = event.requested_reviewer?.login;
        if (removed) requestedReviewers.delete(removed);
        // Team removal
        if (event.requested_team && !removed) {
          meAddedViaTeam = false;
        }
        break;
      }

      case 'reviewed': {
        // Ignore bot reviews unless the bot was an explicit reviewer
        if (isBot(actor, actorObj) && !ciHas(requestedReviewers, actor) && !ciHas(allReviewers, actor)) break;
        const reviewState = event.state;
        // Reviewer leaves requested set
        requestedReviewers.delete(actor);
        lastReview[actor] = { state: reviewState, commitId: event.commit_id || null };
        allReviewers.add(actor);
        // Submitting a review clears any prior @mention (they've engaged)
        mentioned.delete(actor);
        // Also clear from assigned — they've done their part
        assigned.delete(actor);
        // Track reviewer's review state
        if (reviewState === 'approved') reviewerStates[actor] = 'approved';
        else if (reviewState === 'changes_requested') reviewerStates[actor] = 'changes_requested';
        else if (reviewState === 'commented' && reviewerStates[actor] === 'pending')
          reviewerStates[actor] = 'commented';

        if (reviewState === 'changes_requested') {
          prState = STATE.CHANGES_REQUESTED;
        } else if (reviewState === 'commented') {
          commentedAt = ts;
          const elapsed = now - ts;
          if (elapsed >= debounceMs) {
            prState = STATE.COMMENTED;
          }
          // If within debounce, keep current state (or mark COMMENTED for yellow handling)
          // We'll handle debounce in myStatus calculation
          if (elapsed < debounceMs) {
            // Mark as commented but within debounce
            prState = STATE.COMMENTED;
          }
        } else if (reviewState === 'approved') {
          if (autoMergeActive) {
            const timeSinceLastActivity = now - Math.max(lastActivityAt, ts);
            if (timeSinceLastActivity > TWENTY_FOUR_HOURS) {
              prState = STATE.STALLED_MERGE;
            } else {
              prState = STATE.MERGING;
            }
          } else {
            prState = STATE.APPROVED_NO_AUTOMERGE;
          }
        }
        break;
      }

      case 'committed':
      case 'head_ref_force_pushed': {
        // const committer = event.committer?.login || actor;
        // Author commits don't auto-transition to REVIEWING
        // Only transitions if author also re-requested review (handled in review_requested)
        break;
      }

      case 'merged':
        prState = STATE.MERGED;
        break;

      case 'closed':
        prState = STATE.CLOSED;
        break;

      case 'mentioned': {
        // User was @mentioned — they enter attention set
        if (actor && !isBot(actor)) {
          mentioned.set(actor, { status: 'red', since: ts });
        }
        break;
      }
      case 'assigned': {
        const assignee = event.assignee?.login;
        if (assignee && assignee !== author && !isBot(assignee, event.assignee)) {
          assigned.add(assignee);
        }
        break;
      }

      case 'unassigned': {
        const unassignee = event.assignee?.login;
        if (unassignee) assigned.delete(unassignee);
        break;
      }
    }

    // @mentions in comment body
    if (event.body && !isBot(actor, actorObj)) {
      const mentions = event.body.match(/@([a-zA-Z0-9-]+)/g) || [];
      for (const m of mentions) {
        const user = m.slice(1);
        if (user !== actor && !isBot(user) && !ciHas(allReviewers, user)) {
          mentioned.set(user, { status: 'red', since: ts });
        }
      }
    }
  }

  // Post-processing: reconcile state with final autoMerge status
  if (prState === STATE.APPROVED_NO_AUTOMERGE && autoMergeActive) {
    const timeSinceLastActivity = now - lastActivityAt;
    if (timeSinceLastActivity > TWENTY_FOUR_HOURS) {
      prState = STATE.STALLED_MERGE;
    } else {
      prState = STATE.MERGING;
    }
  } else if ((prState === STATE.MERGING || prState === STATE.STALLED_MERGE) && !autoMergeActive) {
    prState = STATE.APPROVED_NO_AUTOMERGE;
  }

  // --- Step 2: Build attention set based on state ---
  const set = {};

  switch (prState) {
    case STATE.DRAFT:
    case STATE.MERGING:
    case STATE.MERGED:
    case STATE.CLOSED:
      // Nobody in attention set
      break;

    case STATE.REVIEWING:
      for (const reviewer of requestedReviewers) {
        if (!isBot(reviewer)) {
          set[reviewer] = 'red';
        }
      }
      break;

    case STATE.CHANGES_REQUESTED:
      set[author] = 'red';
      break;

    case STATE.COMMENTED: {
      const elapsed = now - commentedAt;
      if (elapsed >= debounceMs) {
        set[author] = 'red';
      } else {
        set[author] = 'yellow';
      }
      break;
    }

    case STATE.APPROVED_NO_AUTOMERGE:
      set[author] = 'red';
      break;

    case STATE.STALLED_MERGE:
      set[author] = 'red';
      break;
  }

  // --- Pushes after review (not in upstream) ---
  // GitHub's timeline records plain pushes without a timestamp or actor, so compare SHAs instead: a
  // reviewer whose latest review was on an older commit hasn't seen the newest changes. Once the push
  // has settled for the debounce period, the turn moves from the author back to those reviewers.
  const staleReviewers = headSha
    ? Object.entries(lastReview)
        .filter(
          ([user, r]) =>
            user !== author &&
            r.commitId &&
            r.commitId !== headSha &&
            (r.state === 'changes_requested' || r.state === 'commented'),
        )
        .map(([user]) => user)
    : [];
  const pushSettled = now - headChangedAt >= debounceMs;
  if (
    pushReturnsTurn &&
    pushSettled &&
    staleReviewers.length > 0 &&
    (prState === STATE.CHANGES_REQUESTED || prState === STATE.COMMENTED)
  ) {
    delete set[author];
    for (const user of staleReviewers) set[user] = 'red';
    prState = STATE.REVIEWING;
  }

  // --- Additional rules (override state-based set) ---
  // @mentions
  for (const [user, info] of mentioned) {
    if (!set[user]) {
      set[user] = info.status;
    }
  }

  // Assigned (non-author)
  for (const user of assigned) {
    if (!set[user]) {
      set[user] = 'red';
    }
  }

  // review_request_removed already handled by removing from requestedReviewers

  // Filter bots from final output — but keep bots that are explicit reviewers
  for (const user of Object.keys(set)) {
    if (isBot(user) && !ciHas(allReviewers, user)) {
      delete set[user];
    }
  }

  // Add pending requested reviewers regardless of state (unless PR is done)
  const terminalStates = new Set(['MERGED', 'CLOSED', 'DRAFT', 'MERGING']);
  if (!terminalStates.has(prState)) {
    for (const reviewer of requestedReviewers) {
      if (!set[reviewer]) {
        set[reviewer] = 'red';
      }
    }
    // Add me to attention set if added via team (and not already there)
    if (meAddedViaTeam && !meAddedDirectly && me !== author && !set[me]) {
      set[me] = 'red';
    }
  }

  // --- Never empty (not in upstream) ---
  // Someone always has the turn on an open PR that's under review: if nobody else does, the author does
  // (e.g. no reviewers requested yet). Drafts and PRs on their way to merging stay empty on purpose.
  if (Object.keys(set).length === 0 && isActiveState(prState) && author && !isBot(author)) {
    set[author] = 'red';
  }

  // --- Step 3: Compute myStatus ---
  let myStatus = 'green';
  if (set[me]) {
    myStatus = set[me];
  }

  // Determine user's specific reason for being in attention set
  let myReason = prState;
  if (myStatus !== 'green') {
    // Check if user was requested to review and hasn't submitted a review after that request
    let wasRequestedToReview = false;
    let lastReviewRequestTime = 0;
    let lastMyReviewTime = 0;
    for (const ev of timeline) {
      const t = ev.event || ev.__type;
      if (t === 'review_requested' && ev.requested_reviewer?.login === me) {
        wasRequestedToReview = true;
        lastReviewRequestTime = new Date(ev.created_at || 0).getTime();
      }
      if (t === 'reviewed' && (ev.actor?.login === me || ev.user?.login === me)) {
        lastMyReviewTime = new Date(ev.submitted_at || ev.created_at || 0).getTime();
      }
    }
    if (wasRequestedToReview && lastReviewRequestTime > lastMyReviewTime) {
      myReason = 'REVIEWING';
    }
  }

  // --- Step 4: Compute myRole ---
  let myRole = 'other';
  if (me === author) {
    myRole = 'outgoing';
  } else {
    // Check if me was ever review_requested (direct or via team)
    let wasRequested = requestedReviewers.has(me) || meAddedDirectly || meAddedViaTeam;
    if (!wasRequested) {
      for (const ev of timeline) {
        const t = ev.event || ev.__type;
        if (t === 'review_requested' && ev.requested_reviewer?.login === me) {
          wasRequested = true;
          break;
        }
      }
    }
    if (wasRequested || allReviewers.has(me)) {
      myRole = 'incoming';
    } else if (mentioned.has(me)) {
      myRole = 'mentioned';
    }
  }

  const myLastReviewCommit = lastReview[me]?.commitId || null;
  const pushedSinceMyReview = !!(headSha && myLastReviewCommit && myLastReviewCommit !== headSha);

  // --- Step 5: Compute incomingDetail for incoming PRs ---
  let incomingDetail = null;
  let selfRequested = false;
  if (myRole === 'incoming') {
    let lastMyReviewTime = 0;
    let lastReviewRequestedBy = '';
    let lastReviewRequestTime = 0;
    let hasSubmittedReview = false;
    let wasRerequested = false;

    for (const ev of timeline) {
      const t = ev.event || ev.__type;
      const ts = new Date(ev.created_at || ev.submitted_at || 0).getTime();
      if (t === 'review_requested' && ev.requested_reviewer?.login === me) {
        if (hasSubmittedReview && ts > lastMyReviewTime) {
          wasRerequested = true;
        }
        lastReviewRequestTime = ts;
        lastReviewRequestedBy = ev.actor?.login || ev.user?.login || '';
      }
      if (t === 'reviewed' && (ev.actor?.login === me || ev.user?.login === me)) {
        lastMyReviewTime = ts;
        hasSubmittedReview = true;
      }
    }

    selfRequested = lastReviewRequestedBy === me;
    if (wasRerequested && lastReviewRequestTime > lastMyReviewTime) {
      incomingDetail = 'rereview';
    } else if (hasSubmittedReview) {
      // Check if author pushed commits or replied after my last review
      let authorActivityAfterReview = false;
      for (const ev of timeline) {
        const t = ev.event || ev.__type;
        const ts = new Date(ev.created_at || ev.submitted_at || 0).getTime();
        const actor = ev.actor?.login || ev.user?.login || '';
        if (ts > lastMyReviewTime && actor === author) {
          if (t === 'committed' || t === 'head_ref_force_pushed' || t === 'reviewed' || (ev.body && t !== 'reviewed')) {
            authorActivityAfterReview = true;
            break;
          }
        }
      }
      if (authorActivityAfterReview || pushedSinceMyReview) {
        incomingDetail = 'updated';
      } else {
        // Already reviewed, no new activity — not really needing attention
        incomingDetail = null;
      }
    } else {
      incomingDetail = 'new';
    }
  }

  return {
    set,
    myStatus,
    prState,
    myReason,
    myRole,
    incomingDetail,
    selfRequested,
    allReviewers: [...allReviewers],
    reviewerStates,
    myLastReviewCommit,
    pushedSinceMyReview,
  };
}
