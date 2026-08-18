// --- 1. INITIALIZE SUPABASE ---
const supabaseUrl = 'https://kddxhdmxanfyaycneyio.supabase.co';
const supabaseKey = 'sb_publishable_FjOCmugiTPhvrBBfmXTv2Q_9T8scavS';
// We name our connection "db" to avoid conflicting with the global "supabase" library
const db = supabase.createClient(supabaseUrl, supabaseKey);

// --- 2. GLOBAL STATE ---
let currentTeamId = null;
let currentRoster = [];
let timerInterval = null;
let activeDeadline = null;

// --- LOAD TEAMS DYNAMICALLY ---
async function loadTeams() {
  const { data } = await db.from('teams').select('team_name').order('team_name', { ascending: true });
  if (data) {
    const select = document.getElementById('team-select');
    select.innerHTML = '';
    data.forEach(team => {
      const option = document.createElement('option');
      option.value = team.team_name;
      option.innerText = team.team_name;
      select.appendChild(option);
    });
  }
}
loadTeams();

// --- 3. AUTHENTICATION & STARTUP ---
async function login() {
  const teamName = document.getElementById('team-select').value;
  const pin = document.getElementById('pin-input').value;

  const { data, error } = await db
    .from('teams').select('id, team_name').eq('team_name', teamName).eq('passcode', pin).single();

  if (error || !data) { alert("Incorrect PIN!"); return; }
  startDraftApp(data);
}

async function startDraftApp(teamData) {
  currentTeamId = teamData.id;
  
  document.getElementById('login-screen').style.display = 'none';
  document.getElementById('draft-screen').style.display = 'block';

  // Title Fade Animation
  setTimeout(() => {
    const title = document.getElementById('main-title');
    title.style.opacity = '0'; // Fade out
    setTimeout(() => {
      title.innerText = "Dock Draft"; // Swap text
      title.style.opacity = '1'; // Fade in
    }, 500);
  }, 4000);

  await updateCurrentRoster();
  await setupRosterViewer();
  await loadAvailablePlayers();
  await loadDraftBoard();
  
  subscribeToRealtime();
}

// --- 4. ROSTER LIMIT LOGIC ---
async function updateCurrentRoster() {
  const { data } = await db.from('draft_picks').select('players(position)').eq('team_id', currentTeamId).not('player_id', 'is', null);
  if (data) currentRoster = data.map(pick => pick.players);
}

function canDraftPlayer(newPosition) {
  return true; // Approves every pick, regardless of roster limits
}

// --- 5. RENDER THE UI ---
async function loadAvailablePlayers() {
  // 1. First, find out who is actually on the clock right now
  const { data: currentPick } = await db.from('draft_picks')
    .select('team_id')
    .is('player_id', null)
    .order('pick_number', { ascending: true })
    .limit(1)
    .single();

  // Check if it is currently *your* turn
  const isMyTurn = currentPick && currentPick.team_id === currentTeamId;

  // 2. Fetch all undrafted players
  const { data } = await db.from('players').select('*').eq('is_drafted', false).order('auto_draft_rank', { ascending: true });
  const list = document.getElementById('players-list');
  list.innerHTML = '';
  
  if (data) {
    data.forEach(player => {
      // If it's NOT your turn, force the button to be disabled and grayed out!
      const buttonClass = isMyTurn ? 'btn-draft' : 'btn-draft btn-disabled';
      const buttonAction = isMyTurn ? `onclick="draftPlayer('${player.id}')"` : 'disabled';
      
      const li = document.createElement('li');
      li.innerHTML = `
        <div class="player-info">
          <span class="player-name">${player.name}</span>
          <span class="player-meta"><span class="badge ${player.position.trim()}">${player.position}</span> ${player.nfl_team}</span>
        </div>
        <button class="${buttonClass}" ${buttonAction}>${isMyTurn ? 'Draft' : 'Not Your Turn'}</button>
      `;
      list.appendChild(li);
    });
  }
}

async function loadDraftBoard() {
  const { data } = await db.from('draft_picks')
    // We added 'picked_at' to this query so we can pass it to the timer!
    .select('pick_number, round_number, team_id, picked_at, teams(team_name), players(name, position, nfl_team)')
    .order('pick_number', { ascending: true });

  const list = document.getElementById('board-list');
  list.innerHTML = '';
  
  let onTheClockFound = false;
  let lastPickTime = null; // Track the time of the most recent pick

  if (data) {
    data.forEach(pick => {
      const li = document.createElement('li');
      if (pick.team_id === currentTeamId) li.className = 'my-pick';

      if (pick.players) {
        // If a player is drafted, save their timestamp. 
        // Because the list is ordered by pick_number, this variable will naturally 
        // overwrite itself until it hits the final drafted player.
        lastPickTime = pick.picked_at; 
        
        li.innerHTML = `
          <div class="player-info">
            <span class="player-meta" style="margin-bottom:4px;">${pick.pick_number}. ${pick.teams.team_name}</span>
            <span class="player-name">${pick.players.name} <span class="badge ${pick.players.position.trim()}" style="margin-left:6px;">${pick.players.position}</span></span>
          </div>`;
      } else {
        li.innerHTML = `
          <div class="player-info">
            <span class="player-meta" style="margin-bottom:0;">${pick.pick_number}. ${pick.teams.team_name}</span>
          </div>`;
          
        if (!onTheClockFound) {
          document.getElementById('current-pick-team').innerText = `ON THE CLOCK: ${pick.teams.team_name}`;
          onTheClockFound = true;
          
          // Now that we found the team on the clock, start the timer using the lastPickTime!
          startTimer(lastPickTime); 
        }
      }
      list.appendChild(li);
    });
    
    if (!onTheClockFound) {
      document.getElementById('current-pick-team').innerText = `DRAFT COMPLETE`;
      document.getElementById('clock-display').style.display = 'none';
      if (timerInterval) clearInterval(timerInterval);
    }
  }
}

// --- NEW: ROSTER VIEWER ---
async function setupRosterViewer() {
  const select = document.getElementById('roster-select');
  const { data } = await db.from('teams').select('id, team_name').order('team_name', { ascending: true });
  
  select.innerHTML = '';
  if (data) {
    data.forEach(team => {
      const option = document.createElement('option');
      option.value = team.id;
      option.innerText = team.team_name;
      if (team.id === currentTeamId) option.selected = true;
      select.appendChild(option);
    });
    viewSelectedRoster(); 
  }
}

async function viewSelectedRoster() {
  const selectedTeamId = document.getElementById('roster-select').value;
  const list = document.getElementById('roster-list');
  
  const { data } = await db.from('draft_picks')
    .select('players(name, position, nfl_team)')
    .eq('team_id', selectedTeamId)
    .not('player_id', 'is', null);
    
  list.innerHTML = '';
  
  if (data && data.length > 0) {
    data.forEach(pick => {
      const p = pick.players;
      const li = document.createElement('li');
      li.innerHTML = `
        <div class="player-info">
          <span class="player-name">${p.name}</span>
          <span class="player-meta"><span class="badge ${p.position.trim()}">${p.position}</span> ${p.nfl_team}</span>
        </div>`;
      list.appendChild(li);
    });
  } else {
    list.innerHTML = `<li style="justify-content: center; color: var(--text-muted);">No players drafted yet.</li>`;
  }
}

// --- 6. DRAFT ACTION ---
async function draftPlayer(playerId) {
  // 1. Immediately disable all draft buttons on the page to prevent spam/double-clicks
  const draftButtons = document.querySelectorAll('.btn-draft');
  draftButtons.forEach(btn => {
    btn.disabled = true;
    btn.innerText = 'Drafting...';
  });

  // 2. Call the secure Postgres function (execute_draft_pick)
  // This function validates that it is truly your turn and locks the database row
  const { data, error } = await db.rpc('execute_draft_pick', {
    p_team_id: currentTeamId,
    p_player_id: playerId
  });

  // 3. Handle the response
  if (error || (data && !data.success)) {
    alert(error ? error.message : (data ? data.message : "Error making pick!"));
    location.reload(); // Refresh to sync UI back to reality
    return;
  }

  // Success! The real-time listener will automatically update the UI for everyone.
}

// --- 7. REALTIME UPDATES & AI INSULTS ---
function subscribeToRealtime() {
  db.channel('draft-updates')
    .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'draft_picks' }, async (payload) => {
      await updateCurrentRoster();
      loadAvailablePlayers();
      loadDraftBoard();
      viewSelectedRoster(); 

      if (payload.new.sassy_comment && payload.new.sassy_comment !== payload.old.sassy_comment) {
        showSassyToast(payload.new.sassy_comment);
      }
    }).subscribe();
}

function showSassyToast(message) {
  const toast = document.getElementById('sassy-toast');
  toast.innerText = message;
  toast.className = 'toast-active';
  setTimeout(() => { toast.className = ''; }, 8000); 
}

// --- 8. THE 24-HOUR TIMER ---
function startTimer(lastPickTime) {
  // Clear any existing timer so we don't accidentally run two at once
  if (timerInterval) clearInterval(timerInterval);
  
  const display = document.getElementById('clock-display');

  // If this is the very first pick of the draft (no previous pick time), just show 24 hours
  if (!lastPickTime) {
    display.innerText = "24:00:00";
    return;
  }

  // Calculate the exact deadline: last pick time + 24 hours
  activeDeadline = new Date(lastPickTime).getTime() + (24 * 60 * 60 * 1000);

  // Run this function every 1000 milliseconds (1 second)
  timerInterval = setInterval(() => {
    const now = new Date().getTime();
    const timeRemaining = activeDeadline - now;

    // If time is up, show zeros and stop the timer
    // (The pg_cron job in Supabase will handle the actual auto-drafting)
    if (timeRemaining <= 0) {
      clearInterval(timerInterval);
      display.innerText = "00:00:00";
      display.style.color = "red";
      return;
    }

    // Math to convert raw milliseconds into Hours, Minutes, and Seconds
    const hours = Math.floor((timeRemaining % (1000 * 60 * 60 * 24)) / (1000 * 60 * 60));
    const minutes = Math.floor((timeRemaining % (1000 * 60 * 60)) / (1000 * 60));
    const seconds = Math.floor((timeRemaining % (1000 * 60)) / 1000);

    // Format with leading zeros (e.g. 09:05:01)
    const formattedHours = String(hours).padStart(2, '0');
    const formattedMinutes = String(minutes).padStart(2, '0');
    const formattedSeconds = String(seconds).padStart(2, '0');

    display.innerText = `${formattedHours}:${formattedMinutes}:${formattedSeconds}`;
    
    // Warning colors
    if (hours < 1) display.style.color = "#ef4444"; // Red if under 1 hour
    else display.style.color = ""; // Default color
    
  }, 1000);
}