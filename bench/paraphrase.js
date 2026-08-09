// Paraphrase fixture: real English, because this is the one thing a synthetic
// corpus of coined words cannot test.
//
// Every question below is answerable from exactly one passage, and is worded so
// it shares as little vocabulary with that passage as possible — "uptime" for
// "availability", "vacation" for "paid time off", "let go" for "terminated".
// That is the case keyword search is structurally blind to, and the only reason
// semantic retrieval is worth its cost.

const DOC = `# Service commitments

Our service level agreement guarantees 99.95% availability measured on a calendar-month basis. Credits are issued automatically when the threshold is missed.

# Time away from work

Employees accrue 1.75 days of paid time off per month, which may be carried over to the following calendar year up to a maximum of twenty days.

# Ending employment

Staff whose contracts are terminated without cause receive twelve weeks of severance and continued medical coverage for the same period.

# Expense reimbursement

Receipts must be submitted within thirty days of the outlay. Anything above two hundred pounds requires prior written approval from a line manager.

# Remote arrangements

Colleagues may work from a location of their choosing for up to ninety days per year, provided their timezone overlaps the team's core hours by at least four.

# Data retention

Customer records are purged from primary storage after twenty-four months of inactivity, and from backups within a further ninety days.

# Incident response

A severity-one outage pages the on-call engineer immediately and requires a written post-mortem within five working days.

# Procurement

Any new vendor handling personal data must complete a security review before a contract is signed.

# Onboarding

New joiners are issued a laptop on their first day and must complete security training within two weeks.

# Code review

At least one approving review is required before merging, and two for anything touching authentication.`;

// question -> a distinctive string that must appear in the retrieved passage
const PARAPHRASE_QUERIES = [
  ['what is our uptime promise?', '99.95%'],
  ['how much vacation do I get each year?', '1.75 days'],
  ['what do people get paid if they are let go?', 'twelve weeks of severance'],
  ['how long do I have to claim money back for something I bought?', 'thirty days'],
  ['can I work abroad, and for how long?', 'ninety days per year'],
  ['when is old client information deleted?', 'twenty-four months'],
  ['what happens when the site goes down badly?', 'severity-one'],
  ['do we vet suppliers who touch customer data?', 'security review'],
  ['what does a new hire get on day one?', 'laptop'],
  ['how many people must sign off on a change to login code?', 'two for anything touching authentication']
];

// Same facts, asked using the document's own words. Keyword search should ace
// these — they are the control that shows the paraphrase result is about
// vocabulary mismatch and not about the corpus being hard.
const LITERAL_QUERIES = [
  ['what availability does the service level agreement guarantee?', '99.95%'],
  ['how much paid time off do employees accrue per month?', '1.75 days'],
  ['what severance do terminated staff receive?', 'twelve weeks of severance'],
  ['how many days to submit receipts for reimbursement?', 'thirty days'],
  ['how many days per year may colleagues work remotely?', 'ninety days per year'],
  ['when are customer records purged from primary storage?', 'twenty-four months'],
  ['what does a severity-one outage require?', 'severity-one'],
  ['must a new vendor complete a security review?', 'security review'],
  ['what are new joiners issued on their first day?', 'laptop'],
  ['how many approving reviews for authentication code?', 'two for anything touching authentication']
];

module.exports = { DOC, PARAPHRASE_QUERIES, LITERAL_QUERIES };
