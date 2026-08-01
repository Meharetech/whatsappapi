import MetaSystemSettings from "../models/MetaSystemSettings.js";

const META_BASE = "https://graph.facebook.com";
const getVersion = () => process.env.META_API_VERSION || "v19.0";

class MetaApiService {
  async _resolveAppConfig(overrides = {}) {
    const settings = await MetaSystemSettings.findOne()
      .select("+metaAppSecret")
      .lean();

    let appId = String(
      overrides.appId || settings?.metaAppId || process.env.META_APP_ID || "",
    ).trim();
    let appSecret = String(
      overrides.appSecret ||
        settings?.metaAppSecret ||
        process.env.META_APP_SECRET ||
        "",
    ).trim();
    let apiVersion = String(
      overrides.apiVersion ||
        settings?.apiVersion ||
        process.env.META_API_VERSION ||
        "",
    ).trim();

    if (!apiVersion) apiVersion = getVersion();

    if (!appId || !appSecret) {
      throw new Error(
        "Meta App credentials are not configured. Ask admin to save App ID and App Secret in Meta settings.",
      );
    }

    return { appId, appSecret, apiVersion };
  }

  async _request(method, path, { token, body, params } = {}) {
    const url = new URL(`${META_BASE}/${getVersion()}/${path}`);
    if (params) {
      Object.entries(params).forEach(([k, v]) =>
        url.searchParams.set(k, String(v)),
      );
    }
    if (token) url.searchParams.set("access_token", token);

    const fetchOpts = { method };
    if (body) {
      fetchOpts.headers = { "Content-Type": "application/json" };
      fetchOpts.body = JSON.stringify(body);
    }

    const res = await fetch(url.toString(), fetchOpts);
    const data = await res.json();

    if (data.error) {
      const err = new Error(data.error.message || "Meta API error");
      err.code = data.error.code;
      err.type = data.error.type;
      err.fbtrace_id = data.error.fbtrace_id;
      throw err;
    }
    return data;
  }

  async getLongLivedToken(shortLivedToken, overrides = {}) {
    const { appId, appSecret, apiVersion } =
      await this._resolveAppConfig(overrides);
    const url = new URL(`${META_BASE}/${apiVersion}/oauth/access_token`);
    url.searchParams.set("grant_type", "fb_exchange_token");
    url.searchParams.set("client_id", appId);
    url.searchParams.set("client_secret", appSecret);
    url.searchParams.set("fb_exchange_token", shortLivedToken);

    const res = await fetch(url.toString());
    const data = await res.json();
    if (data.error) throw new Error(data.error.message);
    return data; // { access_token, token_type, expires_in }
  }

  async exchangeCodeForToken(code, redirectUri = "", overrides = {}) {
    const { appId, appSecret, apiVersion } =
      await this._resolveAppConfig(overrides);
    const url = new URL(`${META_BASE}/${apiVersion}/oauth/access_token`);
    url.searchParams.set("client_id", appId);
    url.searchParams.set("client_secret", appSecret);
    url.searchParams.set("code", code);
    if (redirectUri) url.searchParams.set("redirect_uri", redirectUri);

    const res = await fetch(url.toString());
    const data = await res.json();
    if (data.error) throw new Error(data.error.message);
    return data;
  }

  async getUserProfile(token) {
    return this._request("GET", "me", {
      token,
      params: { fields: "id,name,email,picture" },
    });
  }

  async getWABAs(token) {
    const businesses = await this._request("GET", "me/businesses", {
      token,
      params: { fields: "id,name,verification_status" },
    });

    const allWABAs = [];
    for (const biz of businesses.data || []) {
      try {
        const wabas = await this._request(
          "GET",
          `${biz.id}/owned_whatsapp_business_accounts`,
          {
            token,
            params: {
              fields:
                "id,name,currency,timezone_id,on_behalf_of_business_info,message_template_namespace",
            },
          },
        );
        for (const waba of wabas.data || []) {
          allWABAs.push({
            ...waba,
            businessAccountId: biz.id,
            businessName: biz.name,
          });
        }
      } catch (e) {
        console.warn(
          `[MetaAPI] Could not get WABAs for business ${biz.id}:`,
          e.message,
        );
      }
    }
    return allWABAs;
  }

  async getPhoneNumbers(wabaId, token) {
    return this._request("GET", `${wabaId}/phone_numbers`, {
      token,
      params: {
        fields:
          "id,display_phone_number,verified_name,quality_rating,status,code_verification_status,messaging_limit_tier",
      },
    });
  }

  async getTemplates(wabaId, token) {
    return this._request("GET", `${wabaId}/message_templates`, {
      token,
      params: {
        fields: "id,name,language,category,status,components,rejected_reason",
        limit: 100,
      },
    });
  }

  async createTemplate(wabaId, templateData, token) {
    return this._request("POST", `${wabaId}/message_templates`, {
      token,
      body: templateData,
    });
  }

  async deleteTemplate(wabaId, templateName, token) {
    return this._request("DELETE", `${wabaId}/message_templates`, {
      token,
      params: { name: templateName },
    });
  }

  async sendMessage(phoneNumberId, messagePayload, token) {
    return this._request("POST", `${phoneNumberId}/messages`, {
      token,
      body: { messaging_product: "whatsapp", ...messagePayload },
    });
  }

  async sendTextMessage(phoneNumberId, to, text, token) {
    return this.sendMessage(
      phoneNumberId,
      { to, type: "text", text: { body: text } },
      token,
    );
  }

  async sendTemplateMessage(
    phoneNumberId,
    to,
    templateName,
    languageCode,
    components,
    token,
  ) {
    return this.sendMessage(
      phoneNumberId,
      {
        to,
        type: "template",
        template: {
          name: templateName,
          language: { code: languageCode },
          components: components || [],
        },
      },
      token,
    );
  }

  async submitDisplayName(phoneNumberId, displayName, category, token) {
    return this._request("POST", `${phoneNumberId}/whatsapp_business_profile`, {
      token,
      body: {
        messaging_product: "whatsapp",
        about: displayName,
        vertical: category || "OTHER",
      },
    });
  }

  async registerPhoneNumber(phoneNumberId, pin, token) {
    return this._request("POST", `${phoneNumberId}/register`, {
      token,
      body: { messaging_product: "whatsapp", pin },
    });
  }

  async getWABAInfo(wabaId, token) {
    return this._request("GET", wabaId, {
      token,
      params: {
        fields:
          "id,name,currency,timezone_id,status,message_template_namespace",
      },
    });
  }

  async getMessageDeliveryInfo(messageId, token) {
    return this._request("GET", messageId, { token });
  }
}

export default new MetaApiService();
