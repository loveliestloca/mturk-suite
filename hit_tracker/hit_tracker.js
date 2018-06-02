/* globals $ textToSpeech HTML */

Object.assign(Number.prototype, {
  random() {
    return this;// Math.round(Math.random() * 100);
  },
  toMoneyString() {
    return `$${this.random().toFixed(2)}`;
  }
});

function returnWeek() {
  const date = new Date(Date.now());
  const toPST = date.toLocaleString(`en-US`, {
    timeZone: `America/Los_Angeles`
  });
  const isPST = new Date(toPST);
  const day = isPST.getDay();
  const mod = day > 0 ? 0 : 7;

  const p = s => `0${s}`.slice(-2);
  const offset = n => isPST.getDate() - isPST.getDay() - (n || 0);
  const yyyymmdd = d => `${d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate())}`;

  const start = new Date(isPST.setDate(offset(mod)));
  const end = new Date(isPST.setDate(offset() + 6));

  return {
    start: yyyymmdd(start),
    end: yyyymmdd(end),
    which: day > 0 ? `This Week` : `Last Week`
  };
}

function returnMonth() {
  const date = new Date(Date.now());
  const toPST = date.toLocaleString(`en-US`, {
    timeZone: `America/Los_Angeles`
  });
  const isPST = new Date(toPST);

  const d = isPST.getDate();
  const m = isPST.getMonth() + (d > 1 ? 1 : 0);
  const mm = `0${m}`.slice(-2);
  const yyyy = isPST.getFullYear().toString();

  return {
    start: `${yyyy}${mm}01`,
    end: `${yyyy}${mm}31`,
    which: d > 1 ? `This Month` : `Last Month`
  };
}

function openDatabase(name, version) {
  return new Promise(resolve => {
    const request = window.indexedDB.open(name, version);
    request.onsuccess = event => resolve(event.target.result);
  });
}

function syncingStarted() {
  $(document.getElementById(`sync-modal`)).modal({
    backdrop: `static`,
    keyboard: false
  });
}

function syncingUpdated(date, message) {
  document.getElementById(`sync-date`).textContent = date
    ? [date.slice(0, 4), date.slice(4, 6), date.slice(6, 8)].join(`-`)
    : null;
  document.getElementById(`sync-message`).textContent = message || null;
}

function sycningEnded() {
  $(document.getElementById(`sync-modal`)).modal(`hide`);
}

function loggedOut() {
  textToSpeech(`Attention, you are logged out of MTurk.`);
  sycningEnded();
}

function fetchQueue(date) {
  syncingUpdated(date, `fetching queue`);

  return new Promise(resolve => {
    async function fetchLoop() {
      try {
        const response = await fetch(
          `https://worker.mturk.com/tasks?format=json`,
          {
            credentials: `include`
          }
        );

        if (
          response.ok &&
          response.url === `https://worker.mturk.com/tasks?format=json`
        ) {
          const json = await response.json();
          resolve(json);
        } else if (response.url.indexOf(`https://worker.mturk.com/`) === -1) {
          loggedOut();
        } else {
          setTimeout(fetchLoop, 2000);
        }
      } catch (error) {
        setTimeout(fetchLoop, 2000);
      }
    }

    fetchLoop();
  });
}

function fetchDashboard(date) {
  syncingUpdated(date, `fetching dashboard`);

  return new Promise(async resolve => {
    async function fetchLoop() {
      try {
        const response = await fetch(
          `https://worker.mturk.com/dashboard?format=json`,
          {
            credentials: `include`
          }
        );

        if (
          response.ok &&
          response.url === `https://worker.mturk.com/dashboard?format=json`
        ) {
          const json = await response.json();
          resolve(json);
        } else if (response.url.indexOf(`https://worker.mturk.com/`) === -1) {
          loggedOut();
        } else {
          setTimeout(fetchLoop, 2000);
        }
      } catch (error) {
        setTimeout(fetchLoop, 2000);
      }
    }

    fetchLoop();
  });
}

function updateDashboard(days) {
  return new Promise(async resolve => {
    const db = await openDatabase(`hitTrackerDB`, 1);
    const transaction = db.transaction([`day`], `readwrite`);
    const objectStore = transaction.objectStore(`day`);

    Object.keys(days).forEach(day => {
      const request = objectStore.get(day);

      request.onsuccess = event => {
        const result = event.target.result || {
          date: day,
          assigned: 0,
          returned: 0,
          abandoned: 0,
          submitted: 0,
          approved: 0,
          rejected: 0,
          pending: 0,
          paid: 0,
          earnings: 0
        };

        result.day = days[day];
        objectStore.put(result);
      };
    });

    transaction.oncomplete = () => {
      resolve();
    };
  });
}

function syncPrepareDay(date) {
  syncingUpdated(date, `preparing sync`);

  return new Promise(async resolve => {
    const queue = await fetchQueue();
    const hit_ids = queue.tasks.map(o => o.task_id);

    const transaction = (await openDatabase(`hitTrackerDB`, 1)).transaction(
      [`hit`],
      `readwrite`
    );
    const objectStore = transaction.objectStore(`hit`);
    const index = objectStore.index(`date`);
    const only = IDBKeyRange.only(date);

    index.openCursor(only).onsuccess = event => {
      const cursor = event.target.result;

      if (cursor) {
        if (
          cursor.value.state.match(/Accepted|Submitted/) ||
          (cursor.value.state === `Assigned` &&
            !hit_ids.includes(cursor.value.hit_id))
        ) {
          cursor.value.state = `Abandoned`;
          cursor.update(cursor.value);
        }
        cursor.continue();
      }
    };

    transaction.oncomplete = () => {
      resolve();
    };
  });
}

function sync(date) {
  return new Promise(async resolve => {
    await syncPrepareDay(date);

    const fetchDate = [
      date.slice(0, 4),
      date.slice(4, 6),
      date.slice(6, 8)
    ].join(`-`);

    async function fetchLoop(page) {
      const url = `https://worker.mturk.com/status_details/${fetchDate}?page_number=${page}&format=json`;
      const response = await fetch(url, {
        credentials: `include`
      });

      if (response.ok && response.url === url) {
        const json = await response.json();

        if (json.num_results > 0) {
          syncingUpdated(
            date,
            `Updating page ${page} of ${Math.ceil(
              json.total_num_results / 20
            )} for ${json.total_num_results} HITs`
          );

          const transaction = (await openDatabase(
            `hitTrackerDB`,
            1
          )).transaction([`hit`], `readwrite`);
          const objectStore = transaction.objectStore(`hit`);

          json.results.forEach(item => {
            const hit = item;
            const request = objectStore.get(hit.hit_id);

            request.onsuccess = event => {
              const { result } = event.target;

              if (result) {
                Object.keys(result).forEach(key => {
                  if (key !== `state`) {
                    hit[key] = result[key] ? result[key] : hit[key];
                  }
                });
              }

              if (
                hit.state === `Approved` &&
                hit.reward.amount_in_dollars === 0
              ) {
                hit.state = `Paid`;
              }

              hit.date = date;
              objectStore.put(hit);
            };
          });

          transaction.oncomplete = () => {
            const next = page + 1;
            fetchLoop(next);
          };
        } else {
          resolve();
        }
      } else if (response.url.indexOf(`https://worker.mturk.com/`) === -1) {
        throw new Error(`You are logged out!`);
      } else {
        setTimeout(fetchLoop, 2000, page);
      }
    }

    fetchLoop(1);
  });
}

function countDay(date) {
  return new Promise(async resolve => {
    const object = {
      date,

      assigned: 0,
      returned: 0,
      abandoned: 0,

      paid: 0,
      approved: 0,
      rejected: 0,
      submitted: 0,

      earnings: 0
    };

    const transaction = (await openDatabase(`hitTrackerDB`, 1)).transaction(
      [`hit`],
      `readonly`
    );
    const objectStore = transaction.objectStore(`hit`);
    const index = objectStore.index(`date`);
    const only = IDBKeyRange.only(date);

    index.openCursor(only).onsuccess = event => {
      const cursor = event.target.result;

      if (cursor) {
        const state = cursor.value.state.toLowerCase();

        object[state] += 1;

        if (state.match(/paid/)) {
          object.earnings += cursor.value.reward.amount_in_dollars;
        }
        cursor.continue();
      }
    };

    transaction.oncomplete = () => {
      object.earnings = Number(object.earnings.toFixed(2));
      resolve(object);
    };
  });
}

function saveDay(date) {
  return new Promise(async resolve => {
    const count = await countDay(date);

    const transaction = (await openDatabase(`hitTrackerDB`, 1)).transaction(
      [`day`],
      `readwrite`
    );
    const objectStore = transaction.objectStore(`day`);

    const request = objectStore.get(date);

    request.onsuccess = event => {
      const { result } = event.target;

      if (result) {
        count.day = result.day;
      }

      objectStore.put(count);
    };

    transaction.oncomplete = () => {
      resolve();
    };
  });
}

function checkDays(days) {
  syncingUpdated(null, `checking last 45 days`);

  const daysArray = Object.keys(days).sort();

  return new Promise(async resolve => {
    const transaction = (await openDatabase(`hitTrackerDB`, 1)).transaction(
      [`day`],
      `readwrite`
    );
    const objectStore = transaction.objectStore(`day`);
    const bound = IDBKeyRange.bound(
      daysArray[0],
      daysArray[daysArray.length - 1]
    );

    objectStore.openCursor(bound).onsuccess = event => {
      const cursor = event.target.result;

      if (cursor) {
        const { value } = cursor;
        const now = value.day;

        const pending = now.pending === value.submitted;
        const approved = now.approved === value.paid;
        const rejected = now.rejected === value.rejected;
        const submitted =
          now.submitted ===
          value.submitted + value.approved + value.rejected + value.paid;

        if (approved && pending && rejected && submitted) {
          const i = daysArray.indexOf(value.date);

          if (i !== -1) {
            const spliced = daysArray.splice(i, 1);
            saveDay(spliced[0]);
          }
        }

        cursor.continue();
      }
    };

    transaction.oncomplete = () => {
      resolve(daysArray);
    };
  });
}

// refactor needed
function syncDay(date) {
  return new Promise(async resolve => {
    syncingStarted();

    const dash = await fetchDashboard();
    const days = dash.daily_hit_statistics_overview.reduce((acc, cV) => {
      acc[cV.date.substring(0, 10).replace(/-/g, ``)] = cV;
      return acc;
    }, {});

    await updateDashboard(days);

    await sync(date);
    await saveDay(date);

    sycningEnded();
    resolve();
  });
}

function syncLast45() {
  return new Promise(async resolve => {
    syncingStarted();

    const dash = await fetchDashboard();
    const days = dash.daily_hit_statistics_overview.reduce((acc, cV) => {
      acc[cV.date.substring(0, 10).replace(/-/g, ``)] = cV;
      return acc;
    }, {});

    await updateDashboard(days);
    const daysToUpdate = await checkDays(days);

    await Promise.all(
      daysToUpdate.map(async date => {
        await sync(date);
        await saveDay(date);
      })
    );

    /*
    for (const date of daysToUpdate) {
      await sync(date);
      await saveDay(date);
    }
    */

    sycningEnded();
    resolve();
  });
}

function mturkDate() {
  function dst() {
    const today = new Date();
    const year = today.getFullYear();
    const start = new Date(`March 14, ${year} 02:00:00`);
    const end = new Date(`November 07, ${year} 02:00:00`);
    let day = start.getDay();
    start.setDate(14 - day);
    day = end.getDay();
    end.setDate(7 - day);
    return !!(today >= start && today < end);
  }

  const given = new Date();
  const utc = given.getTime() + given.getTimezoneOffset() * 60000;
  const offset = dst() === true ? `-7` : `-8`;
  const amz = new Date(utc + 3600000 * offset);
  const day =
    amz.getDate() < 10
      ? `0${amz.getDate().toString()}`
      : amz.getDate().toString();
  const month =
    amz.getMonth() + 1 < 10
      ? `0${(amz.getMonth() + 1).toString()}`
      : (amz.getMonth() + 1).toString();
  const year = amz.getFullYear().toString();
  return year + month + day;
}

function statusStart(opts) {
  const statusModal = document.getElementById(`status-modal`);
  const statusHeader = document.getElementById(`status-header`);
  const statusMessage = document.getElementById(`status-message`);

  if (opts.header) {
    statusHeader.textContent = opts.header;
  }

  if (opts.message) {
    statusMessage.textContent = opts.message;
  }

  $(statusModal).modal({
    backdrop: `static`,
    keyboard: false
  });
}

function statusUpdate(opts) {
  const statusHeader = document.getElementById(`status-header`);
  const statusMessage = document.getElementById(`status-message`);

  if (opts.header) {
    statusHeader.textContent = opts.header;
  }

  if (opts.message) {
    statusMessage.textContent = opts.message;
  }
}

function statusEnd() {
  const statusModal = document.getElementById(`status-modal`);
  const statusHeader = document.getElementById(`status-header`);
  const statusMessage = document.getElementById(`status-message`);

  statusHeader.textContent = ``;
  statusMessage.textContent = ``;

  $(statusModal).modal(`hide`);
}

function searchingUpdate(message) {
  document.getElementById(`searching-message`).textContent = message || null;
}

function searchStart() {
  const modal = document.getElementById(`searching-modal`);
  searchingUpdate(`This may take some time`);

  $(modal).modal({
    backdrop: `static`,
    keyboard: false
  });
}

function searchEnd() {
  const modal = document.getElementById(`searching-modal`);
  $(modal).modal(`hide`);
}

async function search() {
  searchStart();

  const view = document.getElementById(`view`).value;
  const matching = document.getElementById(`matching`).value;
  const matchingType = document.getElementById(`matching-type`).value;
  const dateTo = document.getElementById(`date-to`).value;
  const dateFrom = document.getElementById(`date-from`).value;

  const transaction = (await openDatabase(`hitTrackerDB`, 1)).transaction(
    [`hit`],
    `readonly`
  );
  const objectStore = transaction.objectStore(`hit`);
  let request;

  if (dateFrom || dateTo) {
    const index = objectStore.index(`date`);
    request = index.openCursor(
      IDBKeyRange.bound(
        dateFrom.replace(/-/g, ``) || `0`,
        dateTo.replace(/-/g, ``) || `99999999`
      )
    );
  } else if (view) {
    const index = objectStore.index(`state`);
    request = index.openCursor(IDBKeyRange.only(view));
  } else {
    const index = objectStore.index(`state`);
    request = index.openCursor();
  }

  let count = 0;

  const results = document.getElementById(`history-results`);

  while (results.firstChild) {
    results.removeChild(results.firstChild);
  }

  const fragment = document.createDocumentFragment();

  request.onsuccess = event => {
    const cursor = event.target.result;

    if (cursor) {
      count += 1;
      searchingUpdate(`Processing HIT ${count}`);

      const { value } = cursor;

      if (matching) {
        const hitValues = [
          value.requester_id,
          value.requester_name,
          value.title
        ];

        if (matchingType === `contain`) {
          let contains = false;

          hitValues.forEach(item => {
            if (item && item.toLowerCase().includes(matching.toLowerCase())) {
              contains = true;
            }
          });

          if (!contains) {
            return cursor.continue();
          }
        } else if (!hitValues.includes(matching)) {
          return cursor.continue();
        }
      }

      if (view && view !== value.state) {
        return cursor.continue();
      }

      const tr = document.createElement(`tr`);

      const date_accepted = document.createElement(`td`);
      date_accepted.textContent = [
        value.date.slice(0, 4),
        value.date.slice(4, 6),
        value.date.slice(6, 8)
      ].join(`-`);
      tr.appendChild(date_accepted);

      const requester_name = document.createElement(`td`);
      requester_name.textContent = value.requester_name;
      tr.appendChild(requester_name);

      const title = document.createElement(`td`);
      title.textContent = value.title;
      tr.appendChild(title);

      if (value.source) {
        const viewSource = document.createElement(`a`);
        viewSource.href = value.source;
        viewSource.target = `_blank`;
        viewSource.className = `btn btn-sm btn-primary mr-1`;
        viewSource.textContent = `Src`;
        title.prepend(viewSource);

        if (value.answer) {
          viewSource.title = Object.keys(value.answer)
            .map(val => `<b>${val}</b>: ${value.answer[val]} <br>`)
            .join(``);

          viewSource.dataset.html = `true`;
          viewSource.dataset.toggle = `tooltip`;
        }
      }

      const reward = document.createElement(`td`);
      reward.textContent = value.reward.amount_in_dollars.toMoneyString();
      tr.appendChild(reward);

      const state = document.createElement(`td`);
      state.textContent = value.state;
      tr.appendChild(state);

      fragment.appendChild(tr);

      return cursor.continue();
    }

    return false;
  };

  transaction.oncomplete = () => {
    const th = document.createElement(`tr`);
    th.className = `bg-primary text-white`;

    const date_accepted = document.createElement(`td`);
    date_accepted.textContent = `Date`;
    th.appendChild(date_accepted);

    const requester_name = document.createElement(`td`);
    requester_name.textContent = `Name`;
    th.appendChild(requester_name);

    const title = document.createElement(`td`);
    title.textContent = `Title`;
    th.appendChild(title);

    const reward = document.createElement(`td`);
    reward.textContent = `Reward`;
    th.appendChild(reward);

    const state = document.createElement(`td`);
    state.textContent = `Status`;
    th.appendChild(state);

    $(`[data-toggle="tooltip"]`).tooltip();

    results.appendChild(th);
    results.appendChild(fragment);

    searchEnd();
  };
}

async function requesterOverview() {
  statusStart({
    header: `Requester Overview`,
    message: `Starting`
  });

  const results = document.getElementById(`history-results`);
  const dateTo = document.getElementById(`date-to`).value;
  const dateFrom = document.getElementById(`date-from`).value;

  const transaction = (await openDatabase(`hitTrackerDB`, 1)).transaction(
    [`hit`],
    `readonly`
  );
  const objectStore = transaction.objectStore(`hit`);
  const range = IDBKeyRange.bound(
    dateFrom.replace(/-/g, ``) || `0`,
    dateTo.replace(/-/g, ``) || `99999999`
  );

  let cursorCount = 0;
  const cursorAccumulator = {};

  objectStore.index(`date`).openCursor(range).onsuccess = event => {
    const cursor = event.target.result;

    if (cursor) {
      cursorCount += 1;
      statusUpdate({ message: `Processing HIT ${cursorCount}` });

      const hit = cursor.value;
      const { requester_id } = hit;

      if (hit.state.match(/Submitted|Pending|Approved|Paid/)) {
        if (cursorAccumulator[requester_id]) {
          cursorAccumulator[requester_id].count += 1;
          cursorAccumulator[requester_id].value += hit.reward.amount_in_dollars;
        } else {
          cursorAccumulator[requester_id] = {
            id: requester_id,
            name: hit.requester_name,
            count: 1,
            value: hit.reward.amount_in_dollars
          };
        }
      }

      cursor.continue();
    } else {
      while (results.firstChild) {
        results.removeChild(results.firstChild);
      }

      const sorted = Object.keys(cursorAccumulator).sort(
        (a, b) => cursorAccumulator[a].value - cursorAccumulator[b].value
      );

      for (let i = sorted.length - 1; i > -1; i -= 1) {
        const req = cursorAccumulator[sorted[i]];

        const tr = document.createElement(`tr`);

        const requester = document.createElement(`td`);
        tr.append(requester);

        const requesterView = document.createElement(`button`);
        requesterView.className = `btn btn-sm btn-primary mr-1`;
        requesterView.textContent = `View`;
        requesterView.addEventListener(`click`, async () => {
          document.getElementById(`view`).value = ``;
          document.getElementById(`matching`).value = req.id;
          document.getElementById(`date-from`).value = ``;
          document.getElementById(`date-to`).value = ``;
          search();
        });
        requester.appendChild(requesterView);

        const requesterLink = document.createElement(`a`);
        requesterLink.href = `https://worker.mturk.com/requesters/${
          req.id
        }/projects`;
        requesterLink.target = `_blank`;
        requesterLink.textContent = req.name;
        requester.appendChild(requesterLink);

        const count = document.createElement(`td`);
        count.textContent = req.count;
        tr.appendChild(count);

        const value = document.createElement(`td`);
        value.textContent = req.value.toMoneyString();
        tr.appendChild(value);

        results.appendChild(tr);
      }
    }
  };

  transaction.oncomplete = () => {
    const tr = document.createElement(`tr`);
    tr.className = `bg-primary text-white`;

    const requester = document.createElement(`td`);
    requester.textContent = `Requester`;
    tr.append(requester);

    const count = document.createElement(`td`);
    count.textContent = `HITs`;
    tr.appendChild(count);

    const value = document.createElement(`td`);
    value.textContent = `Reward`;
    tr.appendChild(value);

    results.prepend(tr);

    statusEnd();
  };
}

async function dailyOverview() {
  searchStart();

  const results = document.getElementById(`history-results`);
  const dateTo = document.getElementById(`date-to`).value;
  const dateFrom = document.getElementById(`date-from`).value;

  function process(days) {
    while (results.firstChild) {
      results.removeChild(results.firstChild);
    }

    days.forEach(day => {
      const tr = document.createElement(`tr`);
      const formattedDate = [
        day.date.slice(0, 4),
        day.date.slice(4, 6),
        day.date.slice(6, 8)
      ].join(`-`);

      const date = document.createElement(`td`);
      date.textContent = formattedDate;
      tr.appendChild(date);

      const submitted = document.createElement(`td`);
      submitted.textContent =
        day.submitted + day.rejected + day.approved + day.paid;
      tr.appendChild(submitted);

      const approved = document.createElement(`td`);
      approved.textContent = day.approved + day.paid;
      tr.appendChild(approved);

      const rejected = document.createElement(`td`);
      rejected.textContent = day.rejected;
      tr.appendChild(rejected);

      const pending = document.createElement(`td`);
      pending.textContent = day.submitted;
      tr.appendChild(pending);

      const ret_aban = document.createElement(`td`);
      ret_aban.textContent = day.returned + day.abandoned;
      tr.appendChild(ret_aban);

      const earningsHits = document.createElement(`td`);
      earningsHits.textContent = day.earnings.toMoneyString();
      tr.appendChild(earningsHits);

      const actions = document.createElement(`span`);
      date.prepend(actions);

      const viewThisDay = document.createElement(`button`);
      viewThisDay.className = `btn btn-sm btn-primary mr-1`;
      viewThisDay.textContent = `View`;
      viewThisDay.addEventListener(`click`, async () => {
        document.getElementById(`view`).value = ``;
        document.getElementById(`matching`).value = ``;
        document.getElementById(`date-from`).value = formattedDate;
        document.getElementById(`date-to`).value = formattedDate;
        search();
      });
      actions.appendChild(viewThisDay);

      const syncThisDay = document.createElement(`button`);
      syncThisDay.className = `btn btn-sm btn-primary mr-1`;
      syncThisDay.textContent = `Sync`;
      syncThisDay.addEventListener(`click`, async event => {
        await syncDay(day.date);
        const {
          classList
        } = event.target.parentElement.parentElement.parentElement;
        classList.add(`bg-warning`);
        classList.add(`text-white`);
      });
      actions.appendChild(syncThisDay);

      if (
        !day.day ||
        day.day.submitted !==
          day.submitted + day.rejected + day.approved + day.paid
      ) {
        syncThisDay.classList.add(`btn-warning`);
      }

      results.prepend(tr);
    });
  }

  const transaction = (await openDatabase(`hitTrackerDB`, 1)).transaction(
    [`day`],
    `readonly`
  );
  const objectStore = transaction.objectStore(`day`);

  if (dateTo || dateFrom) {
    const days = [];

    objectStore.openCursor(
      IDBKeyRange.bound(
        dateFrom.replace(/-/g, ``) || `0`,
        dateTo.replace(/-/g, ``) || `99999999`
      )
    ).onsuccess = event => {
      const cursor = event.target.result;

      if (cursor) {
        days.push(cursor.value);
        cursor.continue();
      } else {
        process(days);
      }
    };
  } else {
    objectStore.getAll().onsuccess = event => {
      process(event.target.result);
    };
  }

  transaction.oncomplete = () => {
    const th = document.createElement(`tr`);
    th.className = `bg-primary text-white`;

    const date = document.createElement(`td`);
    date.textContent = `Date`;
    th.appendChild(date);

    const submitted = document.createElement(`td`);
    submitted.textContent = `Submitted`;
    th.appendChild(submitted);

    const approved = document.createElement(`td`);
    approved.textContent = `Approved`;
    th.appendChild(approved);

    const rejected = document.createElement(`td`);
    rejected.textContent = `Rejected`;
    th.appendChild(rejected);

    const pending = document.createElement(`td`);
    pending.textContent = `Pending`;
    th.appendChild(pending);

    const ret_aban = document.createElement(`td`);
    ret_aban.textContent = `Returned/Abandoned`;
    th.appendChild(ret_aban);

    const earningsHits = document.createElement(`td`);
    earningsHits.textContent = `Earnings HITs`;
    th.appendChild(earningsHits);

    results.prepend(th);

    return searchEnd();
  };
}

function formatDate(date) {
  return [date.slice(0, 4), date.slice(4, 6), date.slice(6, 8)].join(`-`);
}

function currentStatus(type, message) {
  const statusModal = document.getElementById(`status-modal`);

  if (type === `show`)
    $(statusModal).modal({ backdrop: `static`, keyboard: false });
  else if (type === `hide`) $(statusModal).modal(`hide`);

  document.getElementById(`status-message`).textContent = message || ``;
}

function importFileIsHitAutoApp(hit) {
  const editable = hit;
  if (hit.state === `Approved` || hit.state === `Submitted`) {
    const isAfter30 = new Date(formatDate(hit.date)).getTime();
    const whenAfter30 =
      new Date(formatDate(mturkDate())).getTime() - 31 * 24 * 60 * 60 * 1000;

    if (isAfter30 < whenAfter30) {
      editable.state = `Paid`;
    }
  }

  return editable;
}

function importFileHits(hits) {
  currentStatus(`update`, `Importing HITs...`);

  return new Promise(async resolve => {
    const transaction = (await openDatabase(`hitTrackerDB`, 1)).transaction(
      [`hit`],
      `readwrite`
    );
    const objectStore = transaction.objectStore(`hit`);

    for (
      let i = 0, keys = Object.keys(hits), { length } = keys;
      i < length;
      i += 1
    ) {
      const hit = hits[keys[i]];

      if (hit.hit_id && hit.requester_id && hit.state) {
        const autoAppHit = importFileIsHitAutoApp(hit);
        objectStore.put(autoAppHit);
      }
    }

    transaction.oncomplete = () => {
      resolve();
    };
  });
}

function importFileDaysRecount(dates) {
  const promiseData = {};

  return new Promise(async resolve => {
    const transaction = (await openDatabase(`hitTrackerDB`, 1)).transaction(
      [`hit`],
      `readonly`
    );
    const objectStore = transaction.objectStore(`hit`);

    for (let i = 0, { length } = dates; i < length; i += 1) {
      const date = dates[i];

      const dateCount = {
        assigned: 0,
        returned: 0,
        abandoned: 0,
        paid: 0,
        approved: 0,
        rejected: 0,
        submitted: 0,
        earnings: 0
      };

      objectStore
        .index(`date`)
        .openCursor(window.IDBKeyRange.only(date)).onsuccess = event => {
        const cursor = event.target.result;

        if (cursor) {
          const state = cursor.value.state.toLowerCase();

          dateCount[state] += 1;

          if (state.match(/paid/))
            dateCount.earnings += cursor.value.reward.amount_in_dollars;

          cursor.continue();
        } else {
          dateCount.earnings = dateCount.earnings.toFixed(2);
          promiseData[date] = dateCount;
        }
      };
    }

    transaction.oncomplete = () => {
      resolve(promiseData);
    };
  });
}

function importFileDays(days) {
  return new Promise(async resolve => {
    const datesToRecount = days.map(currentValue => currentValue.date);
    const recounted = await importFileDaysRecount(datesToRecount);

    const transaction = (await openDatabase(`hitTrackerDB`, 1)).transaction(
      [`day`],
      `readwrite`
    );
    const objectStore = transaction.objectStore(`day`);

    for (
      let i = 0, keys = Object.keys(days), { length } = keys;
      i < length;
      i += 1
    ) {
      const day = days[keys[i]];

      if (day.day && day.day.earnings && day.date) {
        const recountedDay = { ...day, ...recounted[day.date] };
        objectStore.put(recountedDay);
      }
    }

    transaction.oncomplete = () => {
      resolve();
    };
  });
}

function importFileConvertHITDB(json) {
  const hits = json.HIT.map(currentValue => ({
    assignment_id: null,
    date: currentValue.date.replace(/-/g, ``),
    hit_id: currentValue.hitId,
    requester_feedback:
      currentValue.feedback === `` ? null : currentValue.feedback,
    requester_id: currentValue.requesterId,
    requester_name: currentValue.requesterName,
    reward: {
      amount_in_dollars: currentValue.reward,
      currency_code: null
    },
    state: currentValue.status.split(` `)[0].replace(`Pending`, `Submitted`),
    title: currentValue.title
  }));

  const days = json.STATS.map(currentValue => ({
    day: currentValue,
    date: currentValue.date.replace(/-/g, ``),
    assigned: 0,
    returned: 0,
    abandoned: 0,
    paid: 0,
    approved: 0,
    rejected: 0,
    submitted: 0,
    earnings: 0
  }));

  return { hits, days };
}

function importFile(file) {
  const reader = new window.FileReader();
  reader.readAsText(file);

  reader.onload = async event => {
    currentStatus(`show`, `Loading File...`);

    const json = JSON.parse(event.target.result);

    if (json.hits && json.days) {
      await importFileHits(json.hits);
      await importFileDays(json.days);
    } else if (json.HIT && json.STATS) {
      const converted = importFileConvertHITDB(json);
      await importFileHits(converted.hits);
      await importFileDays(converted.days);
    }

    currentStatus(`hide`);
  };
}

function exportFileHits() {
  let index = 0;
  const promiseData = [];

  return new Promise(async resolve => {
    const transaction = (await openDatabase(`hitTrackerDB`, 1)).transaction(
      [`hit`],
      `readonly`
    );
    const objectStore = transaction.objectStore(`hit`);

    objectStore.openCursor().onsuccess = event => {
      const cursor = event.target.result;

      if (cursor) {
        promiseData.push(event.target.result.value);
        cursor.continue();
      }

      index += 1;
      currentStatus(`update`, `Processing HITs... ${index}`);
    };

    transaction.oncomplete = () => {
      resolve(promiseData);
    };
  });
}

function exportFileDays() {
  let index = 0;
  const promiseData = [];

  return new Promise(async resolve => {
    const transaction = (await openDatabase(`hitTrackerDB`, 1)).transaction(
      [`day`],
      `readonly`
    );
    const objectStore = transaction.objectStore(`day`);

    objectStore.openCursor().onsuccess = event => {
      const cursor = event.target.result;

      if (cursor) {
        promiseData.push(event.target.result.value);
        cursor.continue();
      }

      index += 1;
      currentStatus(`update`, `Processing Days... ${index}`);
    };

    transaction.oncomplete = () => {
      resolve(promiseData);
    };
  });
}

async function exportFile() {
  currentStatus(`show`, `Getting Data...`);

  const data = JSON.stringify({
    hits: await exportFileHits(),
    days: await exportFileDays()
  });

  currentStatus(`update`, `Generating File...`);

  const exportFileSave = document.getElementById(`export-file`);
  exportFileSave.href = window.URL.createObjectURL(
    new window.Blob([data], { type: `application/json` })
  );
  exportFileSave.download = `HIT_Tracker_Backup_${mturkDate()}.json`;
  exportFileSave.click();

  currentStatus(`hide`);
}

function createDoughnutChart(card, groups) {
  const reduced = Object.keys(groups).reduce(
    (acc, cV) => {
      if (groups[cV].count > 1) acc.batches += groups[cV].value;
      else acc.surveys += groups[cV].value;
      acc.total += groups[cV].value;
      return acc;
    },
    { surveys: 0, batches: 0, total: 0 }
  );

  const data = {
    datasets: [
      {
        data: [reduced.surveys.toFixed(2), reduced.batches.toFixed(2)],
        backgroundColor: [`#6c757d`, `#343a40`]
      }
    ],

    labels: ["Surveys", "Batches"]
  };

  const options = {
    responsive: true,
    maintainAspectRatio: false,
    legend: {
      labels: {
        boxWidth: 20,
        fontColor: "white"
      }
    }
  };

  // eslint-disable-next-line
  new Chart(card.querySelector(`canvas`).getContext(`2d`), {
    type: "pie",
    data,
    options
  });

  // eslint-disable-next-line
  card.querySelector(`.h1`).textContent = `${reduced.total.toMoneyString()}`;

  // eslint-disable-next-line
  card.querySelector(`.h6`).textContent = `${(0).toMoneyString()}/hr`;
}

function createDaysLineChart(card, worked) {
  const days = Object.keys(worked);
  const info = days.map(key => (worked[key] || 0.001).random().toFixed(2));

  const data = {
    labels: days.map(item =>
      [item.slice(4, 6), `-`, item.slice(6, 8)].join(``)
    ),
    datasets: [
      {
        label: `Daily Earnings`,
        data: info,
        backgroundColor: `#6c757d`,
        borderColor: `#343a40`
      }
    ]
  };

  const options = {
    responsive: true,
    maintainAspectRatio: false,
    elements: {
      line: {
        tension: 0.25
      }
    },
    tooltips: {
      position: "average",
      intersect: false
    },
    legend: {
      labels: {
        fontColor: "white",
        boxWidth: 0
      }
    },
    scales: {
      xAxes: [
        {
          gridLines: {
            display: false
          },
          ticks: {
            fontColor: `#FFFFFF`
          }
        }
      ],
      yAxes: [
        {
          gridLines: {
            display: false
          },
          ticks: {
            fontColor: `#FFFFFF`
          }
        }
      ]
    }
  };

  // eslint-disable-next-line
  new Chart(card.querySelector(`days canvas`), {
    type: "line",
    data,
    options
  });
}

function createCountsBarChart(card, counts) {
  const data = {
    datasets: [
      {
        label: `Status Breakdown`,
        fontColor: `white`,
        data: [
          counts.assigned.count.random(),
          counts.submitted.count.random(),
          counts.approved.count.random(),
          counts.rejected.count.random(),
          counts.pending.count.random(),
          counts.returned.count.random()
        ],
        backgroundColor: [
          `#6c757d`,
          `#343a40`,
          `#6c757d`,
          `#343a40`,
          `#6c757d`,
          `#343a40`
        ]
      }
    ],

    labels: [
      `Assigned`,
      `Submitted`,
      `Approved`,
      `Rejected`,
      `Pending`,
      `Returned`
    ]
  };

  const options = {
    responsive: true,
    maintainAspectRatio: false,
    legend: {
      labels: {
        fontColor: `white`,
        boxWidth: 0
      }
    },
    tooltips: {
      position: "average",
      intersect: false
    },
    scales: {
      xAxes: [
        {
          gridLines: {
            color: `#FFFFFF`,
            display: false
          },
          ticks: {
            fontColor: `#FFFFFF`, // this here
            fontSize: 8
          }
        }
      ],
      yAxes: [
        {
          // display: false,
          gridLines: {
            color: `#FFFFFF`,
            display: false
          },
          ticks: {
            fontColor: `#FFFFFF` // this here
          }
        }
      ]
    }
  };

  // eslint-disable-next-line
  new Chart(card.querySelector(`counts canvas`), {
    type: "horizontalBar",
    data,
    options
  });
}

function createRewardsBarChart(card, spread) {
  const data = {
    datasets: [
      {
        label: `Reward Breakdown`,
        data: [
          spread[`0-4`].random(),
          spread[`5-9`].random(),
          spread[`10-19`].random(),
          spread[`20-49`].random(),
          spread[`50-99`].random(),
          spread[`100+`].random()
        ],
        backgroundColor: [
          `#6c757d`,
          `#343a40`,
          `#6c757d`,
          `#343a40`,
          `#6c757d`,
          `#343a40`
        ]
      }
    ],

    labels: [
      `$0.00 - $0.04`,
      `$0.05 - $0.09`,
      `$0.10 - $0.19`,
      `$0.20 - $0.49`,
      `$0.50 - $0.99`,
      `$1.00+`
    ]
  };

  const options = {
    responsive: true,
    maintainAspectRatio: false,
    legend: {
      labels: {
        fontColor: `white`,
        boxWidth: 0
      }
    },
    tooltips: {
      position: "average",
      intersect: false
    },
    scales: {
      xAxes: [
        {
          gridLines: {
            color: `#FFFFFF`,
            display: false
          },
          ticks: {
            fontColor: `#FFFFFF`, // this here
            fontSize: 8
          }
        }
      ],
      yAxes: [
        {
          gridLines: {
            color: `#FFFFFF`,
            display: false
          },
          ticks: {
            fontColor: `#FFFFFF` // this here
          }
        }
      ]
    }
  };

  // eslint-disable-next-line
  new Chart(card.querySelector(`rewards canvas`), {
    type: "horizontalBar",
    data,
    options
  });
}

function getOverview(range) {
  return new Promise(async resolve => {
    const db = await openDatabase(`hitTrackerDB`, 1);
    const transaction = db.transaction([`hit`], `readonly`);
    const objectStore = transaction.objectStore(`hit`);

    const days = {};
    const assigned = { count: 0, value: 0 };
    const submitted = { count: 0, value: 0 };
    const approved = { count: 0, value: 0 };
    const rejected = { count: 0, value: 0 };
    const pending = { count: 0, value: 0 };
    const returned = { count: 0, value: 0 };
    const total = { count: 0, value: 0 };
    const groups = {};
    const requesters = {};
    const rewards = {
      "0-4": 0,
      "5-9": 0,
      "10-19": 0,
      "20-49": 0,
      "50-99": 0,
      "100+": 0
    };

    objectStore.index(`date`).openCursor(range).onsuccess = event => {
      const cursor = event.target.result;

      if (cursor) {
        const hit = cursor.value;
        const { state, reward, requester_id, requester_name, title } = hit;
        const { amount_in_dollars } = reward;

        const day = hit.date;
        days[day] = days[day]
          ? days[day] + amount_in_dollars
          : amount_in_dollars;

        total.count += 1;
        total.value += amount_in_dollars;

        if (state.match(/Submitted|Pending|Approved|Paid/)) {
          submitted.count += 1;
          submitted.value += amount_in_dollars;

          if (state.match(/Approved|Paid/)) {
            approved.count += 1;
            approved.value += amount_in_dollars;
          } else if (state.match(/Submitted|Pending/)) {
            pending.count += 1;
            pending.value += amount_in_dollars;
          }

          if (!requesters[requester_id]) {
            requesters[requester_id] = {
              id: requester_id,
              name: hit.requester_name,
              count: 1,
              value: amount_in_dollars
            };
          } else {
            requesters[requester_id].count += 1;
            requesters[requester_id].value += amount_in_dollars;
          }

          const groupKey = requester_name + title + amount_in_dollars;

          if (!groups[groupKey]) {
            groups[groupKey] = {
              count: 1,
              value: amount_in_dollars
            };
          } else {
            groups[groupKey].count += 1;
            groups[groupKey].value += amount_in_dollars;
          }

          if (amount_in_dollars > 1.0) {
            rewards[`100+`] += 1;
          } else if (amount_in_dollars > 0.5) {
            rewards[`50-99`] += 1;
          } else if (amount_in_dollars > 0.2) {
            rewards[`20-49`] += 1;
          } else if (amount_in_dollars > 0.1) {
            rewards[`10-19`] += 1;
          } else if (amount_in_dollars > 0.05) {
            rewards[`5-9`] += 1;
          } else {
            rewards[`0-4`] += 1;
          }
        } else if (state.match(/Returned/)) {
          returned.count += 1;
          returned.value += amount_in_dollars;
        } else if (state.match(/Rejected/)) {
          rejected.count += 1;
          rejected.value += amount_in_dollars;
        }

        assigned.count += 1;
        assigned.value += reward;

        cursor.continue();
      }
    };

    transaction.oncomplete = () => {
      resolve({
        days,
        groups,
        rewards,
        requesters,
        counts: {
          assigned,
          submitted,
          approved,
          rejected,
          pending,
          returned
        }
      });
    };
  });
}

function createRequesterTable(card, requesters) {
  const sorted = Object.keys(requesters).sort(
    (a, b) => requesters[b].value - requesters[a].value
  );

  const trs = sorted
    .map(key => {
      const { id, name, count, value } = requesters[key];
      return HTML`<tr>
        <td>
          <a href="https://worker.mturk.com/requesters/${id}/projects" target="_blank">${name}</a>
        </td>
        <td>${count.random()}</td>
        <td>${value.toMoneyString()}</td>
      </tr>`;
    })
    .join(``);

  card.querySelector(`requesters`).insertAdjacentHTML(
    `afterbegin`,
    `<table class="table table-striped table-bordered table-sm bg-light text-dark">
      <thead>
        <tr>
          <th>Requester</th>
          <th>HITs</th>
          <th>Reward</th>
        </tr>
      </thead>
      <thead>
        ${trs}
      </thead>
    </table>`
  );
}

async function overviewToday() {
  const today = mturkDate();
  const range = IDBKeyRange.only(today);
  const overview = await getOverview(range);

  const card = document.getElementById(`overview-today`);
  createDoughnutChart(card, overview.groups);
  createCountsBarChart(card, overview.counts);
  createRewardsBarChart(card, overview.rewards);
  createRequesterTable(card, overview.requesters);
}

async function overviewWeek() {
  const week = returnWeek();
  const range = IDBKeyRange.bound(week.start, week.end);
  const overview = await getOverview(range);

  const card = document.getElementById(`overview-week`);
  createDoughnutChart(card, overview.groups);
  createDaysLineChart(card, overview.days);
  createCountsBarChart(card, overview.counts);
  createRewardsBarChart(card, overview.rewards);
  createRequesterTable(card, overview.requesters);
}

async function overviewMonth() {
  const card = document.getElementById(`overview-month`);
  const month = returnMonth();
  card.querySelector(`small`).textContent = month.which;

  const range = IDBKeyRange.bound(month.start, month.end);
  const overview = await getOverview(range);

  createDoughnutChart(card, overview.groups);
  createDaysLineChart(card, overview.days);
  createCountsBarChart(card, overview.counts);
  createRewardsBarChart(card, overview.rewards);
  createRequesterTable(card, overview.requesters);
}

async function overviewPending() {
  const db = await openDatabase(`hitTrackerDB`, 1);
  const transaction = db.transaction([`hit`], `readonly`);
  const objectStore = transaction.objectStore(`hit`);
  const range = IDBKeyRange.only(`Submitted`);

  let count = 0;
  let value = 0;

  objectStore.index(`state`).openCursor(range).onsuccess = event => {
    const cursor = event.target.result;

    if (cursor) {
      count += 1;
      value += cursor.value.reward.amount_in_dollars;
      cursor.continue();
    }
  };

  transaction.oncomplete = () => {
    const el = document.querySelector(`#overview-pending overview`);

    el.innerHTML = `<div class="col-6">
        <h3 class="p-4 text-center">${value.toMoneyString()}</h3>
      </div>
      <div class="col-6">
        <h3 class="p-4 text-center">${count.random()}</h3>
      </div>`;
  };
}

async function overviewAwaiting() {
  const db = await openDatabase(`hitTrackerDB`, 1);
  const transaction = db.transaction([`hit`], `readonly`);
  const objectStore = transaction.objectStore(`hit`);
  const range = IDBKeyRange.only(`Approved`);

  let count = 0;
  let value = 0;

  objectStore.index(`state`).openCursor(range).onsuccess = event => {
    const cursor = event.target.result;

    if (cursor) {
      count += 1;
      value += cursor.value.reward.amount_in_dollars;
      cursor.continue();
    }
  };

  transaction.oncomplete = () => {
    const el = document.querySelector(`#overview-awaiting overview`);

    el.innerHTML = `<div class="col-6">
        <h3 class="p-4 text-center">${value.toMoneyString()}</h3>
      </div>
      <div class="col-6">
        <h3 class="p-4 text-center">${count.random()}</h3>
      </div>`;
  };
}

async function overviewTransfer() {
  const response = await fetch(
    `https://worker.mturk.com/dashboard?format=json`,
    {
      credentials: `include`
    }
  );

  const { available_earnings } = await response.json();

  const el = document.querySelector(`#overview-transfer overview`);

  el.innerHTML = `<div class="col-12">
      <h3 class="p-4 text-center">${available_earnings.amount_in_dollars.toMoneyString()}</h3>
    </div>`;
}

overviewToday();
overviewWeek();
overviewMonth();
overviewPending();
overviewAwaiting();
overviewTransfer();

function expander(event) {
  const el = event.target.closest(`[id]`);
  const btn = el.querySelector(`.btn`);
  const expandable = el.querySelector(`.expandable`);

  if (el.classList.contains(`bg-dark`)) {
    el.style = ``;
    el.classList.remove(`bg-dark`);
    btn.classList.remove(`h-100`);
    expandable.hidden = true;
  } else {
    el.style = `width: 100vw !important; max-width: 10000; z-index: 99999; position: absolute; padding: 0; height: 80vh;`;
    el.classList.add(`bg-dark`);
    btn.classList.add(`h-100`);
    expandable.hidden = false;
  }
}

[`today`, `week`, `month`].forEach(i => {
  const el = document.querySelector(`#overview-${i} .btn`);
  el.addEventListener(`click`, expander);
});

document.getElementById(`sync-today`).addEventListener(`click`, async () => {
  await syncDay(mturkDate());

  chrome.runtime.sendMessage({
    hitTrackerGetProjected: true
  });

  window.location.reload();
});

document.getElementById(`sync-last-45`).addEventListener(`click`, async () => {
  await syncLast45();

  chrome.runtime.sendMessage({
    hitTrackerGetProjected: true
  });

  window.location.reload();
});

document
  .getElementById(`requester-overview`)
  .addEventListener(`click`, requesterOverview);

document
  .getElementById(`daily-overview`)
  .addEventListener(`click`, dailyOverview);

document.getElementById(`search`).addEventListener(`click`, search);

document
  .getElementById(`import`)
  .addEventListener(`click`, () =>
    document.getElementById(`import-file`).click()
  );
document
  .getElementById(`import-file`)
  .addEventListener(`change`, event => importFile(event.target.files[0]));

document.getElementById(`export`).addEventListener(`click`, () => exportFile());
