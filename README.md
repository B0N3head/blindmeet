<p align="center">
<a href="https://blindmeet.me">
<img width="1280" height="274"src="https://github.com/user-attachments/assets/1c4b1174-9a5a-4d1c-94da-afa149c4be2b" />
</a>
</p>

### Why does [blindmeet.me](https://blindmeet.me) exist?

I used to use [when2meet](https://www.when2meet.com/) frequently but there seemed to be a pattern of certain people choosing their availability in "dead zones". Making it near impossible to include them and essentially giving them a free pass to not have to attend.
As such, this website was made to **blind** all users from being able to see each others availability. Only the orgainser can see the final outcome.

> [!NOTE]
> Yes [blindmeet](https://blindmeet.me) is indeed mobile friendly :)


<h1 align="center">Features</h1>


<img width="312" height="326" align="right" href="https://blindmeet.me" src="https://github.com/user-attachments/assets/c3568ff8-9fe5-4114-9784-b26df0f55185" />

### Creating an event
- Name your event
- Choose **Specific Dates** or **Days of Week**
- Set the earliest and latest time
- Set an admin password
<br clear="right"/>

### Filling in availability
- Sign in with your name (password is optional but recommended)
- Click or drag across the grid to mark your availability
- Changes are saved automatically
<p align="center">
<a href="https://blindmeet.me">
<img width="503" height="168" src="https://github.com/user-attachments/assets/58158b75-2033-4e10-a655-939a2520eef1" />
</a>
</p>

### Organiser view
- Enter the admin password to unlock
- Shows a colour coded heatmap (the darker the green = the more people free)
- Hover any slot to see exactly who is/isn't available
- Lists all participants who have responded by name
 
<p align="center">
<a href="https://blindmeet.me">
<img width="512" height="272" alt="image" src="https://github.com/user-attachments/assets/572613f2-fc1a-47aa-acf6-1c66f5671a04" />
</a>
</p>

---

## Data compression

### 
Supabase's free tier has storage/bandwidth limits, so [BlindMeet](https://blindmeet.me) compresses the two largest data structures before they are stored or transmitted.

#### Date ranges: run length encoding

When a user picks 41 consecutive days, the initial approach stored the full 41 dates as separate strings. Now they are encoded runs of consecutive dates in the format `"YYYY-MM-DD/N"`

| **Before** | **After** |
| ------ | ------ |
| `[ "2026-06-21", "2026-06-22", "2026-06-23", "2026-06-24", "2026-06-25", "2026-06-26", "2026-06-27", "2026-06-28", "2026-06-29", "2026-06-30", "2026-07-01", "2026-07-02", "2026-07-03", "2026-07-04", "2026-07-05", "2026-07-06", ... ]`|`[ "2026-06-21/41" ]`|

**~36× smaller on average***

> [!NOTE]
> Non-consecutive selections produce multiple ranges `["2026-06-21/5", "2026-07-01/3"]`

---

#### Availability slots: per-date bitmask

Each participant's availability are in sets of 30 minute slots originally identified by and array of `"YYYY-MM-DD|HH:MM"`. For a 9AM to 5PM window that's 16 possible slots per day. Storing each slot was around 18 bytes so just for a fully "available day" that would make roughly 288 bytes :(
Instead of that absolutely amateur way of storing the dates, they are now **one entry per date**, containing a base64 encoded bitmask, where each bit represents each 30-minute slot
| **Before** | **After** |
| ------ | ------ |
| `[ "2026-06-22\09:00", "2026-06-22\09:30", "2026-06-22\10:00", "2026-06-22\10:30", "2026-06-22\11:00", "2026-06-22\11:30", "2026-06-22\12:00", "2026-06-22\12:30", "2026-06-22\13:00", "2026-06-22\13:30", "2026-06-22\14:00", ... ]` | `[ "2026-06-22://8=", "2026-06-23://8=", "2026-06-24://8=" ]` |

**~16× smaller per fully selected day***

> [!NOTE]
> The number of bytes in each mask is `⌈slots_per_day / 8⌉`, a 16-slot (9–17 h) event needs 2 bytes per date; a 48-slot (24-hour) event needs 6 bytes. I love this compression as the ratio only improves with the more slots that are selected as the bitmask size is fixed regardless of how many bits are set.
> If you care to look at how this is achieved then check (`codec.js` or `public/codec.js` they are both the same). They handle encoding/decoding on both the server and in the browser with no external dependencies.

---

## Setup

### Supabase

This project uses supabase for its DB, if you don't like it, fork it and change it 😘<br>
It's free and quick. To setup supabase, just copy the contents of [setup.sql](https://raw.githubusercontent.com/B0N3head/blindmeet/refs/heads/main/setup.sql) into the `SQL Editor` of your chosesn project and your gtg.

> [!CAUTION]
> This project will not work if you do not setup supabase and update the .env (see below) with the required supabase info

### Environment variables

Rename the provided `.env.example` to `.env` and fill out the given values.

> [!TIP]
> `ORIGIN` is used for the OG meta tags. Don't worry about it for local development but make sure to update if you are deploying publicly 

### Actually running the project

You will need [node](https://nodejs.org/en/download) installed.
Once you have setup all the above, then install deps and fire her up.

```bash
npm install
npm run dev
```

Should output something like `blindmeet up @ http://localhost:3003` in the console 🤙

---

### Preview.png??

This is so when you post the link in discord/teams etc it shows a cool preview.<br>
Tries to make the site feel more premium.
<p align="center"><img width="334" height="283" href="https://blindmeet.me" src="https://github.com/user-attachments/assets/8fb5d778-9da7-44d1-a5db-44782663ddf1" /></p>

The source metadata is all in the index.html 👆, the event metadata 👇 is controlled by the server.js

<p align="center"><img width="332" height="105" href="https://blindmeet.me" src="https://github.com/user-attachments/assets/10c6c51e-b079-465b-bee6-177c5769dafa" /></p>

> [!CAUTION]
> This **will not** work on a **local** deployment as discord/teams will not be able to access your server hosted on localhost. Either expose your IP (not recomended) or host it on a server somewhere.
