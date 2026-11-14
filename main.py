"""Decky backend for PlayStation Network social features."""
import asyncio
import json
import os
import re
import tempfile
import time
import uuid
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.parse import parse_qs, urlencode, urlsplit
from urllib.request import HTTPRedirectHandler, Request, build_opener

import decky

AUTH = "https://ca.account.sony.com/api/authz/v3/oauth"
MOBILE = "https://m.np.playstation.com/api"
PROFILE = "https://us-prof.np.community.playstation.net/userProfile/v1/users"
USERS = f"{MOBILE}/userProfile/v1/internal/users"
GROUPS = f"{MOBILE}/gamingLoungeGroups/v1"
PARTIES = f"{MOBILE}/sessionManager/v2"
CLIENT = "09515159-7237-4370-9b40-3806e67c0891"
CLIENT_AUTH = "Basic MDk1MTUxNTktNzIzNy00MzcwLTliNDAtMzgwNmU2N2MwODkxOnVjUGprYTV0bnRCMktxc1A="
REDIRECT = "com.scee.psxandroid.scecompcall://redirect"
SCOPE = "psn:mobile.v2.core psn:clientapp"
FIELDS = "onlineId,accountId,avatarUrls,primaryOnlineStatus,presences(@default,@titleInfo,platform),trophySummary(level)"
GROUP_FIELDS = "groupName,members,mainThread,existsNewArrival"
PARTY_MEMBER_DATA = "WyIiLCIiLCIxIiwiMCIsIjYuMi4wIiwiMCIsIjAiLCIwIiwiIiwiIl0="


class NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


class PsnError(ValueError):
    def __init__(self, status):
        self.status = status
        super().__init__(f"PlayStation Network returned HTTP {status}.")


def request(url, method="GET", headers=None, body=None, redirect=False):
    try:
        with build_opener(NoRedirect()).open(Request(url, body, headers or {}, method=method), timeout=20) as reply:
            raw = reply.read(8 * 1024 * 1024 + 1)
            if len(raw) > 8 * 1024 * 1024:
                raise ValueError("PlayStation Network response is too large.")
            return json.loads(raw) if raw else {}
    except HTTPError as error:
        if redirect and error.code in (302, 303):
            return error.headers.get("Location", "")
        raise PsnError(error.code) from None
    except (URLError, TimeoutError):
        raise ValueError("Could not reach PlayStation Network. Try again.") from None


def identifier(value):
    if not isinstance(value, str) or not re.fullmatch(r"[A-Za-z0-9_-]{1,128}", value):
        raise ValueError("Invalid PlayStation identifier.")
    return value


def player(row):
    presence = (row.get("presences") or [{}])[0]
    avatar = row.get("avatarUrl") or (row.get("avatarUrls") or [{}])[0].get("avatarUrl")
    return {
        "id": str(row["accountId"]),
        "name": row.get("onlineId") or str(row["accountId"]),
        "avatar": avatar if isinstance(avatar, str) and avatar.startswith("https://") else None,
        "status": row.get("primaryOnlineStatus") or presence.get("onlineStatus"),
        "game": presence.get("titleName") or presence.get("npTitleName"),
        "platform": presence.get("platform"),
        "level": (row.get("trophySummary") or {}).get("level"),
    }


def message(row):
    detail = row.get("messageDetail") or {}
    body = row.get("body") or detail.get("body")
    sender = row.get("sender") or {}
    return {
        "id": str(row.get("messageUid", "")),
        "text": body if isinstance(body, str) else None,
        "sender": str(sender.get("accountId", "")),
        "name": sender.get("onlineId"),
        "date": row.get("createdTimestamp"),
    }


class Plugin:
    async def _main(self):
        self.path = Path(decky.DECKY_PLUGIN_SETTINGS_DIR) / "session.json"
        self.lock = asyncio.Lock()
        self.tokens = {}
        try:
            self.tokens = json.loads(self.path.read_text())
        except (OSError, ValueError):
            pass

    def _save(self, tokens):
        self.path.parent.mkdir(parents=True, exist_ok=True)
        with tempfile.NamedTemporaryFile(mode="w", dir=self.path.parent, delete=False) as file:
            try:
                json.dump(tokens, file)
                file.flush()
                os.replace(file.name, self.path)
            finally:
                Path(file.name).unlink(missing_ok=True)
        self.tokens = tokens

    async def _oauth(self, params):
        result = await asyncio.to_thread(request, f"{AUTH}/token", "POST", {
            "Authorization": CLIENT_AUTH, "Content-Type": "application/x-www-form-urlencoded",
        }, urlencode({**params, "token_format": "jwt"}).encode())
        if not result.get("access_token"):
            raise ValueError("PlayStation sign-in failed.")
        return {
            "access": result["access_token"],
            "refresh": result.get("refresh_token") or params.get("refresh_token"),
            "expires": time.time() + int(result.get("expires_in", 3600)),
        }

    async def sign_in(self, npsso):
        if not isinstance(npsso, str) or not re.fullmatch(r"[A-Za-z0-9_-]{64}", npsso.strip()):
            raise ValueError("Enter a valid Sony NPSSO code.")
        query = urlencode(dict(access_type="offline", client_id=CLIENT, redirect_uri=REDIRECT, response_type="code", scope=SCOPE))
        async with self.lock:
            location = await asyncio.to_thread(request, f"{AUTH}/authorize?{query}", "GET",
                                               {"Cookie": f"npsso={npsso.strip()}"}, None, True)
            redirect = urlsplit(location) if isinstance(location, str) else urlsplit("")
            code = parse_qs(redirect.query).get("code", [""])[0]
            if not code or redirect.scheme + "://" + redirect.netloc != REDIRECT:
                raise ValueError("Sony rejected the NPSSO code. Get a fresh code and try again.")
            self._save(await self._oauth(dict(code=code, redirect_uri=REDIRECT, grant_type="authorization_code")))

    async def sign_out(self):
        async with self.lock:
            self.path.unlink(missing_ok=True)
            self.tokens = {}

    async def _access(self, rejected=None):
        async with self.lock:
            access = self.tokens.get("access")
            if access and access != rejected and self.tokens.get("expires", 0) > time.time() + 60:
                return access
            refresh = self.tokens.get("refresh")
            if not refresh:
                raise ValueError("Sign in to PlayStation Network first.")
            self._save(await self._oauth(dict(refresh_token=refresh, grant_type="refresh_token", scope=SCOPE)))
            return self.tokens["access"]

    async def _api(self, url, method="GET", payload=None, headers=None):
        body = json.dumps(payload).encode() if payload is not None else None
        access = await self._access()
        extra = dict(headers or {})
        if url.startswith(PARTIES + "/"):
            extra["X-PSN-SESSION-MANAGER-CPSS-ID"] = "js_DEjjRwWk-4JY_BwF7Fo"
            session = re.search(r"/partySessions/([A-Za-z0-9_-]+)", url)
            if session:
                extra["X-PSN-SESSION-MANAGER-SESSION-IDS"] = session[1]
        def fetch(token):
            return request(url, method, {
                "Authorization": f"Bearer {token}", "Content-Type": "application/json",
                "Accept-Language": "en-US", **extra,
            }, body)
        try:
            return await asyncio.to_thread(fetch, access)
        except PsnError as error:
            if error.status != 401 or method != "GET":
                raise
            return await asyncio.to_thread(fetch, await self._access(rejected=access))

    async def load(self):
        if not self.tokens:
            return None
        profile = await self._api(f"{PROFILE}/me/profile2?{urlencode({'fields': FIELDS})}")
        friends = []
        for offset in range(0, 2000, 100):
            query = urlencode(dict(fields=FIELDS, offset=offset, limit=100))
            page = await self._api(f"{PROFILE}/me/friends/profiles2?{query}")
            items = page["profiles"]
            friends.extend(map(player, items))
            if not items or len(friends) >= int(page.get("totalResults", len(friends))):
                break
        return {"me": player(profile["profile"]), "friends": list({item["id"]: item for item in friends}.values())}

    async def search(self, query):
        query = query.strip()
        if not query or len(query) > 100:
            raise ValueError("Enter a PlayStation Online ID.")
        result = await self._api(f"{MOBILE}/search/v1/universalSearch", "POST", {
            "searchTerm": query, "domainRequests": [{"domain": "SocialAllAccounts"}],
        })
        domains = result.get("domainResponses") or [{}]
        return [player(row["socialMetadata"]) for row in domains[0].get("results", []) if row.get("socialMetadata", {}).get("accountId")]

    async def relationships(self, blocked):
        path, key = ("blocks", "blockList") if blocked else ("friends/receivedRequests", "receivedRequests")
        accounts = []
        for offset in range(0, 2000, 100):
            query = urlencode(dict(limit=100, offset=offset))
            result = await self._api(f"{USERS}/me/{path}?{query}")
            page = result.get(key, [])
            accounts.extend(str(account) for account in page)
            if not page or len(accounts) >= result.get("totalItemCount", len(accounts)):
                break
        profiles = {}
        for offset in range(0, len(accounts), 100):
            query = urlencode(dict(accountIds=",".join(accounts[offset:offset + 100])))
            result = await self._api(f"{USERS}/profiles?{query}")
            profiles.update({str(row["accountId"]): player(row) for row in result.get("profiles", [])})
        return [profiles.get(account) or {"id": account, "name": account} for account in dict.fromkeys(accounts)]

    async def inbox(self):
        async def groups(favorite):
            query = urlencode(dict(favoriteFilter=favorite, includeFields=GROUP_FIELDS, limit=200))
            return (await self._api(f"{GROUPS}/members/me/groups?{query}"))["groups"]
        pages = await asyncio.gather(groups("notFavorite"), groups("favorite"))
        threads = {}
        for group in pages[0] + pages[1]:
            thread = group.get("mainThread") or {}
            threads[group["groupId"]] = {
                "id": group["groupId"], "thread": thread.get("threadId") or group["groupId"],
                "name": (group.get("groupName") or {}).get("value"),
                "members": [player(row) for row in group.get("members", []) if row.get("accountId")],
                "unread": bool(thread.get("existsUnreadMessage")),
                "latest": message(thread["latestMessage"]) if thread.get("latestMessage") else None,
            }
        return sorted(threads.values(), key=lambda item: (item["latest"] or {}).get("date") or "", reverse=True)

    async def create_chat(self, account):
        result = await self._api(f"{GROUPS}/groups", "POST", {"invitees": [{"accountId": identifier(account)}]})
        return {"id": result["groupId"], "thread": (result.get("mainThread") or {}).get("threadId") or result["groupId"]}

    async def messages(self, group, thread):
        path = f"{GROUPS}/members/me/groups/{identifier(group)}/threads/{identifier(thread)}/messages"
        result = await self._api(path)
        return sorted((message(row) for row in result["messages"]), key=lambda row: row["date"] or "")

    async def send_message(self, group, thread, text):
        if not isinstance(text, str) or not text.strip() or len(text) > 256:
            raise ValueError("Enter a message of up to 256 characters.")
        await self._api(f"{GROUPS}/groups/{identifier(group)}/threads/{identifier(thread)}/messages",
                        "POST", {"messageType": 1, "body": text.strip()})

    async def parties(self):
        response = await self._api(f"{PARTIES}/users/me/partySessionsInvitations")
        keys = ("invitations", "partySessionsInvitations", "invitedPartySessions")
        invites = response if isinstance(response, list) else next((response[key] for key in keys if response.get(key)), [])
        ids = []
        for invite in invites:
            session = invite.get("party") or invite.get("session") or invite.get("v2PartySession") or {}
            session_id = invite.get("partySessionId") or invite.get("sessionId") or session.get("sessionId")
            if session_id:
                ids.append(identifier(session_id))
        result = await self._api(f"{PARTIES}/sys/gameBase/parties/bulkGet?limit=11", "POST",
                                 {"groupInvitedPartySessions": list(dict.fromkeys(ids))[:11]})
        parties = {row["sessionId"]: {
            "id": row["sessionId"], "name": row.get("sessionName"),
            "members": [player(member) for member in row.get("members", []) if member.get("accountId")],
            "invited": row["sessionId"] in ids,
        } for row in result.get("parties", []) if row.get("sessionId")}
        for session_id in ids:
            parties.setdefault(session_id, {"id": session_id, "name": None, "members": [], "invited": True})
        return list(parties.values())

    def _party_member(self):
        return {"accountId": "me", "platform": "me", "voiceChatActivated": False,
                "pushContexts": [{"contextId": str(uuid.uuid4())}], "customData4": PARTY_MEMBER_DATA}

    async def create_party(self, friends_only):
        visibility = "FRIENDS_ONLY" if friends_only else "INVITE_ONLY"
        response = await self._api(f"{PARTIES}/partySessions", "POST", {"v2PartySessions": [{
            "sessionType": "ROOM", "sessionName": "", "maxMembers": 16,
            "visibilityType": visibility, "joinableUserType": "FRIENDS" if friends_only else "INVITE_ONLY",
            "members": [self._party_member()],
        }]}, {"X-PSN-SESSION-MANAGER-SET-PROFANITY-FILTER-LANGUAGE-CODE": "en-US"})
        return response["v2PartySessions"][0]["sessionId"]

    async def join_party(self, session):
        await self._api(f"{PARTIES}/partySessions/{identifier(session)}/members",
                        "POST", {"members": [self._party_member()]})

    async def leave_party(self, session):
        await self._api(f"{PARTIES}/partySessions/{identifier(session)}/members/me", "DELETE")

    async def invite(self, session, account):
        await self._api(f"{PARTIES}/partySessions/{identifier(session)}/invitations", "POST", {
            "invitationType": "NORMAL", "invitations": [{"to": {"accountId": identifier(account)}}],
            "invitationsToGroups": [],
        })
