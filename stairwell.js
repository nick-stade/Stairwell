// ============================================================
// Stairwell — Browser Extension Logic
// ============================================================

const SUPABASE_URL = "https://oddxmqnzxcpaudsvihsg.supabase.co";
const SUPABASE_ANON_KEY = "sb_publishable_ujg9F6Zmf8xll6D-gltxLg_GGLArU4D";
const EDGE_FN_URL = `${SUPABASE_URL}/functions/v1/send-verification-code`;

// Initialize Supabase client (supabase.js must be loaded first)
const sb = supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

// ── App State ──
let currentUser = null;     // { id, email, display_name, first_name, last_name }
let pendingEmail = null;
let pendingFirst = null;
let pendingLast = null;
let currentAssignment = null; // full assignment object when viewing thread
let currentCourseId = null;

// ============================================================
// Navigation
// ============================================================

function showView(viewId) {
  document.querySelectorAll(".view").forEach((v) => v.classList.remove("active"));
  const el = document.getElementById(viewId);
  if (el) el.classList.add("active");
}

// ============================================================
// Initialization
// ============================================================

document.addEventListener("DOMContentLoaded", async () => {
  bindEvents();
  await tryRestoreSession();
});

async function tryRestoreSession() {
  try {
    const stored = await chromeStorageGet([
      "access_token",
      "refresh_token",
      "stairwell_user",
    ]);

    if (stored.access_token && stored.refresh_token) {
      const { data, error } = await sb.auth.setSession({
        access_token: stored.access_token,
        refresh_token: stored.refresh_token,
      });

      if (!error && data?.session) {
        // Session restored — update stored tokens in case they were refreshed
        await chromeStorageSet({
          access_token: data.session.access_token,
          refresh_token: data.session.refresh_token,
        });

        if (stored.stairwell_user) {
          currentUser = stored.stairwell_user;
        } else {
          // Fetch user from DB using auth id
          const authUser = data.session.user;
          const { data: dbUser } = await sb
            .from("users")
            .select("*")
            .eq("auth_id", authUser.id)
            .single();
          if (dbUser) {
            currentUser = dbUser;
            await chromeStorageSet({ stairwell_user: dbUser });
          }
        }

        if (currentUser) {
          await enterApp();
          return;
        }
      }
    }
  } catch (err) {
    console.warn("Session restore failed:", err);
  }

  // No valid session — check if user was mid-verification
  const pending = await chromeStorageGet(["pending_email", "pending_first", "pending_last"]);
  if (pending.pending_email) {
    pendingEmail = pending.pending_email;
    pendingFirst = pending.pending_first;
    pendingLast = pending.pending_last;
    showView("view-login-code");
  } else {
    showView("view-login-email");
  }
}

// ============================================================
// Event Binding (CSP-safe, no inline handlers)
// ============================================================

function bindEvents() {
  // Login: send code
  document.getElementById("btn-send-code").addEventListener("click", handleSendCode);

  // Login: verify code
  document.getElementById("btn-verify-code").addEventListener("click", handleVerifyCode);

  // Login: resend / back
  document.getElementById("btn-resend").addEventListener("click", (e) => {
    e.preventDefault();
    handleSendCode();
  });
  document.getElementById("btn-back-email").addEventListener("click", async (e) => {
    e.preventDefault();
    await chromeStorageRemove(["pending_email", "pending_first", "pending_last"]);
    pendingEmail = null;
    pendingFirst = null;
    pendingLast = null;
    showView("view-login-email");
  });

  // Home: user badge (logout)
  document.getElementById("btn-user-badge").addEventListener("click", () => {
    document.getElementById("logout-modal").classList.add("active");
  });

  // Logout modal
  document.getElementById("btn-logout-cancel").addEventListener("click", () => {
    document.getElementById("logout-modal").classList.remove("active");
  });
  document.getElementById("btn-logout-confirm").addEventListener("click", handleLogout);

  // Assignment view: back
  document.getElementById("btn-back-home").addEventListener("click", () => {
    currentAssignment = null;
    showView("view-home");
  });

  // Assignment view: rate button
  document.getElementById("btn-rate").addEventListener("click", () => {
    openRatingView();
  });

  // Assignment view: post comment
  document.getElementById("btn-post-comment").addEventListener("click", handlePostComment);
  document.getElementById("comment-input").addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handlePostComment();
    }
  });

  // Rating view: back
  document.getElementById("btn-back-assignment").addEventListener("click", () => {
    if (currentAssignment) {
      openAssignmentView(currentAssignment.id);
    }
  });

  // Rating view: submit
  document.getElementById("btn-submit-rating").addEventListener("click", handleSubmitRating);
}

// ============================================================
// Auth: Send Verification Code
// ============================================================

async function handleSendCode() {
  const emailInput = document.getElementById("login-email");
  const firstInput = document.getElementById("login-first");
  const lastInput = document.getElementById("login-last");
  const statusEl = document.getElementById("login-email-status");
  const btn = document.getElementById("btn-send-code");

  const email = emailInput.value.trim().toLowerCase();
  const first = firstInput.value.trim();
  const last = lastInput.value.trim();

  // Validate
  if (!email || (!email.endsWith("@mines.edu") && !email.endsWith("@colorado.edu"))) {
    setStatus(statusEl, "Please enter a valid @mines.edu or @colorado.edu email.", "error");
    return;
  }
  if (!first || !last) {
    setStatus(statusEl, "First and last name are required.", "error");
    return;
  }

  pendingEmail = email;
  pendingFirst = first;
  pendingLast = last;

  btn.disabled = true;
  btn.innerHTML = '<span class="spinner"></span>Sending…';
  setStatus(statusEl, "", "");

  try {
    const res = await fetch(EDGE_FN_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${SUPABASE_ANON_KEY}`,
      },
      body: JSON.stringify({ action: "send-code", email }),
    });
    const data = await res.json();

    if (!res.ok) {
      setStatus(statusEl, data.error || "Failed to send code.", "error");
      return;
    }

    // Move to code entry — persist pending state so reopening
    // the extension returns to the code screen
    await chromeStorageSet({
      pending_email: pendingEmail,
      pending_first: pendingFirst,
      pending_last: pendingLast,
    });
    showView("view-login-code");
  } catch (err) {
    setStatus(statusEl, "Network error. Please try again.", "error");
  } finally {
    btn.disabled = false;
    btn.textContent = "Send verification code";
  }
}

// ============================================================
// Auth: Verify Code
// ============================================================

async function handleVerifyCode() {
  const codeInput = document.getElementById("login-code");
  const statusEl = document.getElementById("login-code-status");
  const btn = document.getElementById("btn-verify-code");

  const code = codeInput.value.trim();
  if (!code || code.length !== 6) {
    setStatus(statusEl, "Enter the 6-digit code from your email.", "error");
    return;
  }

  btn.disabled = true;
  btn.innerHTML = '<span class="spinner"></span>Verifying…';
  setStatus(statusEl, "", "");

  try {
    const res = await fetch(EDGE_FN_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${SUPABASE_ANON_KEY}`,
      },
      body: JSON.stringify({
        action: "verify-code",
        email: pendingEmail,
        code,
        first_name: pendingFirst,
        last_name: pendingLast,
      }),
    });
    const data = await res.json();

    if (!res.ok) {
      setStatus(statusEl, data.error || "Verification failed.", "error");
      return;
    }

    // Set Supabase session
    if (data.access_token && data.refresh_token) {
      await sb.auth.setSession({
        access_token: data.access_token,
        refresh_token: data.refresh_token,
      });

      // Persist tokens and clear pending verification state
      await chromeStorageSet({
        access_token: data.access_token,
        refresh_token: data.refresh_token,
        stairwell_user: data.user,
      });
      await chromeStorageRemove(["pending_email", "pending_first", "pending_last"]);
    } else {
      // Still store the user even without tokens
      await chromeStorageSet({ stairwell_user: data.user });
      await chromeStorageRemove(["pending_email", "pending_first", "pending_last"]);
    }

    currentUser = data.user;
    await enterApp();
  } catch (err) {
    setStatus(statusEl, "Network error. Please try again.", "error");
  } finally {
    btn.disabled = false;
    btn.textContent = "Verify";
  }
}

// ============================================================
// Auth: Logout
// ============================================================

async function handleLogout() {
  await sb.auth.signOut();
  await chromeStorageRemove(["access_token", "refresh_token", "stairwell_user", "pending_email", "pending_first", "pending_last"]);
  currentUser = null;
  document.getElementById("logout-modal").classList.remove("active");
  showView("view-login-email");
}

// ============================================================
// Enter App — Decide Home vs Assignment
// ============================================================

async function enterApp() {
  // Set user badge
  const badge = document.getElementById("btn-user-badge");
  badge.textContent = currentUser.display_name || currentUser.email;

  // Check if current tab is a Canvas assignment URL
  try {
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tabs[0]?.url) {
      const match = tabs[0].url.match(
        /\/courses\/(\d+)\/assignments\/(\d+)/
      );
      if (match) {
        const canvasCourseId = parseInt(match[1]);
        const canvasAssignmentId = parseInt(match[2]);

        // Look up assignment by Canvas IDs
        const { data: asgn } = await sb
          .from("assignments")
          .select("*, courses!inner(*)")
          .eq("canvas_assignment_id", canvasAssignmentId)
          .eq("courses.canvas_course_id", canvasCourseId)
          .single();

        if (asgn) {
          await openAssignmentView(asgn.id);
          return;
        }
      }
    }
  } catch (err) {
    // tabs API may fail in certain contexts, fall through to home
    console.warn("Tab check error:", err);
  }

  await loadHomeView();
}

// ============================================================
// Home View
// ============================================================

async function loadHomeView() {
  showView("view-home");
  const container = document.getElementById("courses-container");
  container.innerHTML = '<p style="text-align:center;color:var(--text-muted);padding:20px;">Loading…</p>';

  try {
    // Get courses the user is enrolled in
    const { data: memberships, error } = await sb
      .from("course_memberships")
      .select("course_id, role, courses(id, course_code, title, term)")
      .eq("user_id", currentUser.id);

    if (error) throw error;

    if (!memberships || memberships.length === 0) {
      container.innerHTML = `
        <div class="empty-state">
          <div class="icon">📚</div>
          <p>No courses found.<br/>Ask your instructor to add you to a course on Stairwell.</p>
        </div>`;
      return;
    }

    // Get assignments for these courses
    const courseIds = memberships.map((m) => m.courses.id);
    const { data: assignments } = await sb
      .from("assignments")
      .select("id, course_id, title, due_date")
      .in("course_id", courseIds)
      .order("due_date", { ascending: true, nullsFirst: false });

    // Group assignments by course
    const assignmentsByCourse = {};
    (assignments || []).forEach((a) => {
      if (!assignmentsByCourse[a.course_id]) assignmentsByCourse[a.course_id] = [];
      assignmentsByCourse[a.course_id].push(a);
    });

    // Render
    container.innerHTML = "";
    memberships.forEach((m) => {
      const course = m.courses;
      const card = document.createElement("div");
      card.className = "course-card";

      const courseAssignments = assignmentsByCourse[course.id] || [];

      let assignmentListHTML = "";
      if (courseAssignments.length === 0) {
        assignmentListHTML =
          '<div style="padding:10px 14px 10px 20px;color:var(--text-muted);font-size:12px;">No assignments yet</div>';
      } else {
        assignmentListHTML = courseAssignments
          .map((a) => {
            return `<div class="assignment-item" data-assignment-id="${a.id}">
              <span class="asgn-name">${escapeHtml(a.title)}</span>
            </div>`;
          })
          .join("");
      }

      card.innerHTML = `
        <div class="course-header">
          <div class="course-info">
            <div class="course-code">${escapeHtml(course.course_code)}</div>
            <div class="course-title">${escapeHtml(course.title)} · ${escapeHtml(course.term)}</div>
          </div>
          <span class="chevron">▸</span>
        </div>
        <div class="assignment-list">${assignmentListHTML}</div>`;

      // Toggle accordion
      const header = card.querySelector(".course-header");
      header.addEventListener("click", () => {
        card.classList.toggle("open");
      });

      // Assignment click handlers
      card.querySelectorAll(".assignment-item").forEach((item) => {
        item.addEventListener("click", () => {
          const id = parseInt(item.getAttribute("data-assignment-id"));
          openAssignmentView(id);
        });
      });

      container.appendChild(card);
    });
  } catch (err) {
    console.error("Home load error:", err);
    container.innerHTML =
      '<div class="empty-state"><p>Failed to load courses. Please try again.</p></div>';
  }
}

// ============================================================
// Assignment / Thread View
// ============================================================

async function openAssignmentView(assignmentId) {
  showView("view-assignment");
  const titleEl = document.getElementById("assignment-title");
  const listEl = document.getElementById("comments-list");
  const inputEl = document.getElementById("comment-input");

  titleEl.textContent = "Loading…";
  listEl.innerHTML = "";
  inputEl.value = "";

  try {
    // Fetch assignment
    const { data: asgn, error: asgnErr } = await sb
      .from("assignments")
      .select("*")
      .eq("id", assignmentId)
      .single();

    if (asgnErr || !asgn) {
      titleEl.textContent = "Assignment not found";
      return;
    }

    currentAssignment = asgn;
    titleEl.textContent = asgn.title;

    // Fetch comments (top-level only, with user info)
    const { data: comments } = await sb
      .from("comments")
      .select("*, users(first_name, last_name)")
      .eq("assignment_id", assignmentId)
      .is("parent_comment_id", null)
      .order("created_at", { ascending: true });

    // Fetch vote totals for all comments in this assignment
    const { data: allComments } = await sb
      .from("comments")
      .select("id")
      .eq("assignment_id", assignmentId);

    const allCommentIds = (allComments || []).map((c) => c.id);
    let voteTotals = {};
    let userVotes = {};

    if (allCommentIds.length > 0) {
      // Get vote totals from the view
      const { data: vt } = await sb
        .from("comment_vote_totals")
        .select("*")
        .in("comment_id", allCommentIds);
      (vt || []).forEach((v) => {
        voteTotals[v.comment_id] = v.score;
      });

      // Get current user's votes
      const { data: uv } = await sb
        .from("votes")
        .select("comment_id, value")
        .eq("user_id", currentUser.id)
        .in("comment_id", allCommentIds);
      (uv || []).forEach((v) => {
        userVotes[v.comment_id] = v.value;
      });
    }

    // Sort by most upvoted
    const sorted = (comments || []).sort((a, b) => {
      const sa = voteTotals[a.id] || 0;
      const sb_ = voteTotals[b.id] || 0;
      return sb_ - sa;
    });

    // Fetch all replies for this assignment
    const { data: replies } = await sb
      .from("comments")
      .select("*, users(first_name, last_name)")
      .eq("assignment_id", assignmentId)
      .not("parent_comment_id", "is", null)
      .order("created_at", { ascending: true });

    const repliesByParent = {};
    (replies || []).forEach((r) => {
      if (!repliesByParent[r.parent_comment_id]) repliesByParent[r.parent_comment_id] = [];
      repliesByParent[r.parent_comment_id].push(r);
    });

    // Render
    listEl.innerHTML = "";
    if (sorted.length === 0) {
      listEl.innerHTML =
        '<div class="empty-state" style="padding:20px 0;"><p>No comments yet. Be the first!</p></div>';
    }

    sorted.forEach((comment) => {
      const el = renderComment(comment, voteTotals, userVotes, repliesByParent, assignmentId);
      listEl.appendChild(el);
    });
  } catch (err) {
    console.error("Assignment load error:", err);
    listEl.innerHTML = '<div class="empty-state"><p>Failed to load comments.</p></div>';
  }
}

function renderComment(comment, voteTotals, userVotes, repliesByParent, assignmentId) {
  const card = document.createElement("div");
  card.className = "comment-card";

  const authorName = comment.users
    ? `${comment.users.first_name} ${comment.users.last_name.charAt(0)}.`
    : "Anonymous";

  const score = voteTotals[comment.id] || 0;
  const userVote = userVotes[comment.id] || 0;
  const childReplies = repliesByParent[comment.id] || [];
  const hasReplies = childReplies.length > 0;

  card.innerHTML = `
    <div class="comment-author">${escapeHtml(authorName)}</div>
    <div class="comment-body">${escapeHtml(comment.body)}</div>
    <div class="comment-footer">
      <button class="vote-btn ${userVote === 1 ? "active" : ""}" data-comment-id="${comment.id}">
        ▲ <span class="vote-count">${score}</span>
      </button>
      <button class="reply-btn" data-comment-id="${comment.id}">Reply</button>
      ${hasReplies ? `<button class="reply-toggle" data-comment-id="${comment.id}">▸ ${childReplies.length} ${childReplies.length === 1 ? "reply" : "replies"}</button>` : ""}
    </div>
    <div class="reply-input-container" data-reply-for="${comment.id}">
      <input type="text" placeholder="Write a reply…" />
      <button data-comment-id="${comment.id}">Send</button>
    </div>
    <div class="replies-container" data-replies-for="${comment.id}"></div>`;

  // Vote handler
  const voteBtn = card.querySelector(".vote-btn");
  voteBtn.addEventListener("click", async () => {
    await handleVote(comment.id, voteBtn, userVotes);
  });

  // Reply button handler
  const replyBtn = card.querySelector(".reply-btn");
  replyBtn.addEventListener("click", () => {
    const replyContainer = card.querySelector(`.reply-input-container[data-reply-for="${comment.id}"]`);
    replyContainer.classList.toggle("open");
    const input = replyContainer.querySelector("input");
    if (replyContainer.classList.contains("open")) input.focus();
  });

  // Reply send handler
  const replySendBtn = card.querySelector(`.reply-input-container button`);
  replySendBtn.addEventListener("click", async () => {
    const input = card.querySelector(`.reply-input-container input`);
    const body = input.value.trim();
    if (!body) return;

    replySendBtn.disabled = true;
    const { error } = await sb.from("comments").insert({
      assignment_id: assignmentId,
      user_id: currentUser.id,
      parent_comment_id: comment.id,
      body,
    });
    replySendBtn.disabled = false;

    if (!error) {
      input.value = "";
      // Refresh the thread
      await openAssignmentView(assignmentId);
    }
  });

  // Reply toggle handler
  const toggleBtn = card.querySelector(".reply-toggle");
  if (toggleBtn) {
    const repliesDiv = card.querySelector(`.replies-container[data-replies-for="${comment.id}"]`);
    toggleBtn.addEventListener("click", () => {
      repliesDiv.classList.toggle("open");
      toggleBtn.textContent = repliesDiv.classList.contains("open")
        ? `▾ ${childReplies.length} ${childReplies.length === 1 ? "reply" : "replies"}`
        : `▸ ${childReplies.length} ${childReplies.length === 1 ? "reply" : "replies"}`;
    });

    // Render child replies
    childReplies.forEach((reply) => {
      const replyCard = document.createElement("div");
      replyCard.className = "comment-card";
      const replyAuthor = reply.users
        ? `${reply.users.first_name} ${reply.users.last_name.charAt(0)}.`
        : "Anonymous";
      const replyScore = voteTotals[reply.id] || 0;
      const replyUserVote = userVotes[reply.id] || 0;

      replyCard.innerHTML = `
        <div class="comment-author">${escapeHtml(replyAuthor)}</div>
        <div class="comment-body">${escapeHtml(reply.body)}</div>
        <div class="comment-footer">
          <button class="vote-btn ${replyUserVote === 1 ? "active" : ""}" data-comment-id="${reply.id}">
            ▲ <span class="vote-count">${replyScore}</span>
          </button>
        </div>`;

      const replyVoteBtn = replyCard.querySelector(".vote-btn");
      replyVoteBtn.addEventListener("click", async () => {
        await handleVote(reply.id, replyVoteBtn, userVotes);
      });

      repliesDiv.appendChild(replyCard);
    });
  }

  return card;
}

// ============================================================
// Voting
// ============================================================

async function handleVote(commentId, btn, userVotes) {
  const currentVote = userVotes[commentId] || 0;

  if (currentVote === 1) {
    // Remove vote
    await sb.from("votes").delete().eq("comment_id", commentId).eq("user_id", currentUser.id);
    userVotes[commentId] = 0;
    btn.classList.remove("active");
    const countEl = btn.querySelector(".vote-count");
    countEl.textContent = parseInt(countEl.textContent) - 1;
  } else {
    // Upsert vote
    await sb.from("votes").upsert(
      { comment_id: commentId, user_id: currentUser.id, value: 1 },
      { onConflict: "user_id,comment_id" }
    );
    userVotes[commentId] = 1;
    btn.classList.add("active");
    const countEl = btn.querySelector(".vote-count");
    countEl.textContent = parseInt(countEl.textContent) + 1;
  }
}

// ============================================================
// Post Comment
// ============================================================

async function handlePostComment() {
  if (!currentAssignment || !currentUser) return;
  const input = document.getElementById("comment-input");
  const body = input.value.trim();
  if (!body) return;

  const btn = document.getElementById("btn-post-comment");
  btn.disabled = true;

  const { error } = await sb.from("comments").insert({
    assignment_id: currentAssignment.id,
    user_id: currentUser.id,
    body,
  });

  btn.disabled = false;

  if (!error) {
    input.value = "";
    await openAssignmentView(currentAssignment.id);
  }
}

// ============================================================
// Rating View
// ============================================================

let ratingValues = { relevance: 0, clarity: 0, time_reasonableness: 0 };

async function openRatingView() {
  if (!currentAssignment) return;
  showView("view-rating");

  document.getElementById("rating-title").textContent = currentAssignment.title;
  setStatus(document.getElementById("rating-status"), "", "");

  // Reset
  ratingValues = { relevance: 0, clarity: 0, time_reasonableness: 0 };

  // Check if user already rated
  const { data: existing } = await sb
    .from("ratings")
    .select("*")
    .eq("assignment_id", currentAssignment.id)
    .eq("user_id", currentUser.id)
    .single();

  if (existing) {
    ratingValues.relevance = existing.relevance;
    ratingValues.clarity = existing.clarity;
    ratingValues.time_reasonableness = existing.time_reasonableness;
    document.getElementById("btn-submit-rating").textContent = "Update rating";
  } else {
    document.getElementById("btn-submit-rating").textContent = "Submit rating";
  }

  // Render metrics
  const metricsEl = document.getElementById("rating-metrics");
  const metrics = [
    { key: "relevance", label: currentAssignment.metric_a },
    { key: "clarity", label: currentAssignment.metric_b },
    { key: "time_reasonableness", label: currentAssignment.metric_c },
  ];

  metricsEl.innerHTML = metrics
    .map(
      (m) => `
    <div class="rating-metric" data-metric="${m.key}">
      <div class="metric-label">${escapeHtml(m.label)}</div>
      <div class="star-row">
        ${[1, 2, 3, 4, 5]
          .map(
            (n) =>
              `<button class="star ${ratingValues[m.key] >= n ? "filled" : ""}" data-metric="${m.key}" data-value="${n}">★</button>`
          )
          .join("")}
      </div>
    </div>`
    )
    .join("");

  // Bind star clicks
  metricsEl.querySelectorAll(".star").forEach((star) => {
    star.addEventListener("click", () => {
      const metric = star.getAttribute("data-metric");
      const value = parseInt(star.getAttribute("data-value"));
      ratingValues[metric] = value;

      // Update stars display
      const row = star.parentElement;
      row.querySelectorAll(".star").forEach((s) => {
        const v = parseInt(s.getAttribute("data-value"));
        s.classList.toggle("filled", v <= value);
      });
    });
  });
}

async function handleSubmitRating() {
  const statusEl = document.getElementById("rating-status");
  const btn = document.getElementById("btn-submit-rating");

  if (!ratingValues.relevance || !ratingValues.clarity || !ratingValues.time_reasonableness) {
    setStatus(statusEl, "Please rate all three metrics.", "error");
    return;
  }

  btn.disabled = true;

  const { error } = await sb.from("ratings").upsert(
    {
      assignment_id: currentAssignment.id,
      user_id: currentUser.id,
      relevance: ratingValues.relevance,
      clarity: ratingValues.clarity,
      time_reasonableness: ratingValues.time_reasonableness,
    },
    { onConflict: "assignment_id,user_id" }
  );

  btn.disabled = false;

  if (error) {
    setStatus(statusEl, "Failed to save rating. Try again.", "error");
  } else {
    setStatus(statusEl, "Rating saved!", "success");
    setTimeout(() => {
      if (currentAssignment) openAssignmentView(currentAssignment.id);
    }, 800);
  }
}

// ============================================================
// Helpers
// ============================================================

function setStatus(el, msg, type) {
  el.textContent = msg;
  el.className = "status-msg" + (type ? ` ${type}` : "");
}

function escapeHtml(str) {
  const d = document.createElement("div");
  d.textContent = str || "";
  return d.innerHTML;
}

// Chrome storage wrappers (promisified)
function chromeStorageGet(keys) {
  return new Promise((resolve) => {
    chrome.storage.local.get(keys, resolve);
  });
}

function chromeStorageSet(data) {
  return new Promise((resolve) => {
    chrome.storage.local.set(data, resolve);
  });
}

function chromeStorageRemove(keys) {
  return new Promise((resolve) => {
    chrome.storage.local.remove(keys, resolve);
  });
}