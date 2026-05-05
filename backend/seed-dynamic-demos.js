require('dotenv').config();
const mongoose = require('mongoose');

const DEMO_SEED = process.env.DEMO_SEED || `${Date.now()}-${Math.random()}`;
process.env.DEMO_SEED = DEMO_SEED;
const { seedSalesDemo, createRandom, money, pad } = require('./seed-sales-demo');

const BASE_DATE = process.env.DEMO_BASE_DATE
  ? new Date(`${process.env.DEMO_BASE_DATE}T00:00:00.000Z`)
  : new Date();

const FINANCE_DEMO_URI = process.env.FINANCE_DEMO_URI || 'mongodb://localhost:27017/finance_demo_mcp';
const CRICKET_DEMO_URI = process.env.CRICKET_DEMO_URI || 'mongodb://localhost:27017/cricket_demo_mcp';

const dateDaysAgo = (days) => {
  const date = new Date(BASE_DATE);
  date.setUTCDate(date.getUTCDate() - days);
  return date;
};

const choose = (random, items) => items[Math.floor(random() * items.length)];

const connectFresh = async (uri) => {
  const connection = await mongoose.createConnection(uri, {
    serverSelectionTimeoutMS: 5000
  }).asPromise();
  await connection.db.dropDatabase();
  return connection;
};

const seedFinanceDemo = async () => {
  const random = createRandom(`finance:${DEMO_SEED}`);
  const connection = await connectFresh(FINANCE_DEMO_URI);

  try {
    const db = connection.db;
    const holderNames = [
      'Aarav Mehta', 'Riya Sharma', 'Sara Khan', 'Nikhil Jain', 'Anika Joshi',
      'Dev Nair', 'Priya Mehta', 'Rohan Nair', 'Kabir Iyer', 'Ishaan Patel',
      'Mira Kapoor', 'Vihaan Singh', 'Aanya Das', 'Arjun Verma', 'Karan Shah',
      'Sana Ali', 'Neha Rao', 'Yash Mehta', 'Viraj Sen', 'Parth Joshi'
    ];
    const accountTypes = ['savings', 'current', 'credit_card', 'loan', 'wallet'];
    const cities = ['Mumbai', 'Ahmedabad', 'Delhi', 'Jaipur', 'Bengaluru', 'Chennai', 'Hyderabad', 'Kolkata', 'Pune', 'Indore'];
    const categories = ['salary', 'rent', 'groceries', 'travel', 'utilities', 'shopping', 'healthcare', 'education', 'investment', 'emi'];
    const merchants = ['FreshMart', 'Metro Fuel', 'QuickPay', 'Urban Stores', 'CloudKart', 'HealthPlus', 'EduPro', 'TravelGo'];

    const accounts = holderNames.map((holder, index) => ({
      account_id: `ACC-${pad(index + 1, 4)}`,
      holder_name: holder,
      account_type: choose(random, accountTypes),
      city: cities[index % cities.length],
      balance: money(5000 + random() * 450000),
      credit_limit: money(50000 + random() * 350000),
      opened_date: dateDaysAgo(1600 - index * 19),
      status: index % 13 === 0 ? 'review' : 'active',
      risk_score: Math.floor(250 + random() * 650)
    }));

    const transactions = [];
    for (let index = 1; index <= Number(process.env.FINANCE_DEMO_TRANSACTION_COUNT || 320); index += 1) {
      const account = choose(random, accounts);
      const type = choose(random, ['credit', 'debit']);
      const amount = money(150 + random() * (type === 'credit' ? 90000 : 45000));
      transactions.push({
        transaction_id: `TXN-${pad(index, 5)}`,
        account_id: account.account_id,
        holder_name: account.holder_name,
        transaction_date: dateDaysAgo(Math.floor(random() * 540)),
        transaction_type: type,
        category: choose(random, categories),
        merchant: choose(random, merchants),
        amount,
        city: account.city,
        status: index % 31 === 0 ? 'failed' : index % 17 === 0 ? 'pending' : 'completed'
      });
    }

    const symbols = ['RELIANCE', 'TCS', 'INFY', 'HDFCBANK', 'ICICIBANK', 'NIFTYBEES', 'GOLDBEES', 'BTC', 'ETH', 'AAPL'];
    const investments = accounts.slice(0, 16).map((account, index) => {
      const quantity = money(1 + random() * 90);
      const averagePrice = money(100 + random() * 8500);
      const marketPrice = money(averagePrice * (0.75 + random() * 0.7));
      return {
        investment_id: `INV-${pad(index + 1, 4)}`,
        account_id: account.account_id,
        holder_name: account.holder_name,
        symbol: symbols[index % symbols.length],
        asset_class: index % 4 === 0 ? 'crypto' : index % 3 === 0 ? 'etf' : 'equity',
        quantity,
        average_price: averagePrice,
        market_price: marketPrice,
        market_value: money(quantity * marketPrice),
        unrealized_pnl: money(quantity * (marketPrice - averagePrice))
      };
    });

    const budgets = categories.slice(0, 8).map((category, index) => {
      const planned = money(12000 + random() * 80000);
      const actual = money(planned * (0.65 + random() * 0.75));
      return {
        budget_id: `BUD-${pad(index + 1, 4)}`,
        category,
        month: BASE_DATE.toISOString().slice(0, 7),
        planned_amount: planned,
        actual_amount: actual,
        variance: money(planned - actual),
        owner: holderNames[index % holderNames.length]
      };
    });

    await db.collection('accounts').insertMany(accounts);
    await db.collection('transactions').insertMany(transactions);
    await db.collection('investments').insertMany(investments);
    await db.collection('budgets').insertMany(budgets);

    await Promise.all([
      db.collection('accounts').createIndex({ account_id: 1 }, { unique: true }),
      db.collection('accounts').createIndex({ holder_name: 1 }),
      db.collection('transactions').createIndex({ transaction_id: 1 }, { unique: true }),
      db.collection('transactions').createIndex({ account_id: 1, status: 1 }),
      db.collection('transactions').createIndex({ category: 1, city: 1 }),
      db.collection('investments').createIndex({ account_id: 1, symbol: 1 }),
      db.collection('budgets').createIndex({ category: 1, month: 1 })
    ]);

    console.log(`Seeded ${connection.name} at ${FINANCE_DEMO_URI}`);
    console.log(`Dynamic seed: ${DEMO_SEED}`);
    console.log(JSON.stringify({
      accounts: accounts.length,
      transactions: transactions.length,
      investments: investments.length,
      budgets: budgets.length
    }, null, 2));
  } finally {
    await connection.close();
  }
};

const seedCricketDemo = async () => {
  const random = createRandom(`cricket:${DEMO_SEED}`);
  const connection = await connectFresh(CRICKET_DEMO_URI);

  try {
    const db = connection.db;
    const teamNames = [
      'Mumbai Kings', 'Delhi Capitals XI', 'Bengaluru Falcons', 'Chennai Strikers',
      'Kolkata Tigers', 'Hyderabad Royals', 'Jaipur Warriors', 'Ahmedabad Titans'
    ];
    const countries = ['India', 'Australia', 'England', 'New Zealand', 'South Africa', 'Sri Lanka', 'West Indies'];
    const roles = ['batter', 'bowler', 'all_rounder', 'wicket_keeper'];
    const firstNames = ['Rohan', 'Dhruv', 'Aarav', 'Karan', 'Yash', 'Ishaan', 'Viraj', 'Aditya', 'Kabir', 'Arjun', 'Vihaan'];
    const lastNames = ['Nair', 'Verma', 'Khan', 'Das', 'Mehta', 'Kapoor', 'Patel', 'Jain', 'Joshi', 'Iyer', 'Singh'];

    const teams = teamNames.map((teamName, index) => ({
      team_id: `TEAM-${pad(index + 1, 3)}`,
      team_name: teamName,
      home_ground: `${teamName.split(' ')[0]} Stadium`,
      coach: `${choose(random, firstNames)} ${choose(random, lastNames)}`,
      country: 'India',
      wins: Math.floor(4 + random() * 14),
      losses: Math.floor(2 + random() * 12),
      net_run_rate: money(-1.2 + random() * 2.8)
    }));

    const players = [];
    const playerCount = Number(process.env.CRICKET_DEMO_PLAYER_COUNT || 80);
    for (let index = 1; index <= playerCount; index += 1) {
      const team = teams[(index - 1) % teams.length];
      const playerName = index === 1
        ? 'Rohan Nair'
        : index === 2
          ? 'Dhruv Verma'
          : `${choose(random, firstNames)} ${choose(random, lastNames)} ${index}`;
      const role = choose(random, roles);
      const matchesPlayed = Math.floor(5 + random() * 45);
      players.push({
        player_id: `PLY-${pad(index, 4)}`,
        player_name: playerName,
        team_id: team.team_id,
        team_name: team.team_name,
        country: index === 3 ? 'Australia' : choose(random, countries),
        role,
        batting_style: choose(random, ['right_hand', 'left_hand']),
        bowling_style: role === 'batter' ? 'none' : choose(random, ['right_arm_fast', 'left_arm_fast', 'off_spin', 'leg_spin']),
        age: Math.floor(19 + random() * 20),
        matches_played: matchesPlayed,
        total_runs: Math.floor(random() * 2800),
        wickets: role === 'batter' || role === 'wicket_keeper' ? Math.floor(random() * 12) : Math.floor(10 + random() * 110),
        strike_rate: money(95 + random() * 65),
        average: money(18 + random() * 45)
      });
    }

    const matches = [];
    const innings = [];
    const performances = [];
    const venues = ['Mumbai', 'Delhi', 'Bengaluru', 'Chennai', 'Kolkata', 'Hyderabad', 'Jaipur', 'Ahmedabad'];
    const matchCount = Number(process.env.CRICKET_DEMO_MATCH_COUNT || 64);
    for (let index = 1; index <= matchCount; index += 1) {
      const teamA = teams[Math.floor(random() * teams.length)];
      let teamB = teams[Math.floor(random() * teams.length)];
      if (teamA.team_id === teamB.team_id) teamB = teams[(teams.indexOf(teamA) + 1) % teams.length];
      const winner = choose(random, [teamA, teamB]);
      const matchId = `MATCH-${pad(index, 4)}`;
      const matchDate = dateDaysAgo(Math.floor(random() * 420));

      matches.push({
        match_id: matchId,
        match_date: matchDate,
        format: choose(random, ['T20', 'ODI']),
        season: BASE_DATE.getUTCFullYear(),
        venue: choose(random, venues),
        team_a: teamA.team_name,
        team_b: teamB.team_name,
        winner: winner.team_name,
        toss_winner: choose(random, [teamA.team_name, teamB.team_name]),
        player_of_match: choose(random, players).player_name,
        margin_runs: Math.floor(random() * 80),
        margin_wickets: Math.floor(random() * 9)
      });

      [teamA, teamB].forEach((team, inningIndex) => {
        const runs = Math.floor(120 + random() * 110);
        const wickets = Math.floor(3 + random() * 8);
        innings.push({
          innings_id: `INN-${pad(innings.length + 1, 5)}`,
          match_id: matchId,
          team_id: team.team_id,
          team_name: team.team_name,
          innings_number: inningIndex + 1,
          runs,
          wickets,
          overs: money(16 + random() * 4),
          run_rate: money(runs / 20),
          extras: Math.floor(random() * 18)
        });
      });

      const selectedPlayers = players
        .filter((player) => [teamA.team_name, teamB.team_name].includes(player.team_name))
        .sort(() => random() - 0.5)
        .slice(0, 12);
      selectedPlayers.forEach((player) => {
        performances.push({
          performance_id: `PERF-${pad(performances.length + 1, 6)}`,
          match_id: matchId,
          player_id: player.player_id,
          player_name: player.player_name,
          team_name: player.team_name,
          role: player.role,
          runs: Math.floor(random() * 110),
          balls: Math.floor(5 + random() * 60),
          fours: Math.floor(random() * 10),
          sixes: Math.floor(random() * 7),
          wickets: player.role === 'batter' ? 0 : Math.floor(random() * 5),
          economy_rate: player.role === 'batter' ? null : money(4 + random() * 8),
          catches: Math.floor(random() * 3)
        });
      });
    }

    await db.collection('teams').insertMany(teams);
    await db.collection('players').insertMany(players);
    await db.collection('matches').insertMany(matches);
    await db.collection('innings').insertMany(innings);
    await db.collection('performances').insertMany(performances);

    await Promise.all([
      db.collection('teams').createIndex({ team_id: 1 }, { unique: true }),
      db.collection('players').createIndex({ player_id: 1 }, { unique: true }),
      db.collection('players').createIndex({ player_name: 1 }),
      db.collection('players').createIndex({ country: 1, role: 1 }),
      db.collection('matches').createIndex({ match_id: 1 }, { unique: true }),
      db.collection('matches').createIndex({ winner: 1, match_date: 1 }),
      db.collection('innings').createIndex({ match_id: 1, team_name: 1 }),
      db.collection('performances').createIndex({ player_name: 1, match_id: 1 })
    ]);

    console.log(`Seeded ${connection.name} at ${CRICKET_DEMO_URI}`);
    console.log(`Dynamic seed: ${DEMO_SEED}`);
    console.log(JSON.stringify({
      teams: teams.length,
      players: players.length,
      matches: matches.length,
      innings: innings.length,
      performances: performances.length
    }, null, 2));
  } finally {
    await connection.close();
  }
};

const requestedSeeders = new Set(process.argv.slice(2).map((arg) => arg.replace(/^--/, '').toLowerCase()));
const shouldRun = (name) => requestedSeeders.size === 0 || requestedSeeders.has('all') || requestedSeeders.has(name);

const run = async () => {
  console.log(`Dynamic demo seed: ${DEMO_SEED}`);
  if (shouldRun('sales')) await seedSalesDemo();
  if (shouldRun('finance')) await seedFinanceDemo();
  if (shouldRun('cricket')) await seedCricketDemo();
};

run().catch((error) => {
  console.error('Failed to seed dynamic demo databases:', error);
  process.exit(1);
});
