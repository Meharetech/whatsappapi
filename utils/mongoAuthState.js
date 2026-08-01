import { WhatsAppAuthState } from "../models/index.js";
import { initAuthCreds, BufferJSON, proto } from "@whiskeysockets/baileys";

export const useMongoAuthState = async (sessionId) => {
  const writeData = async (data, dataType, dataId) => {
    try {
      const dataJson = JSON.stringify(data, BufferJSON.replacer);
      await WhatsAppAuthState.updateOne(
        { sessionId, dataType, dataId },
        { dataJson },
        { upsert: true }
      );
    } catch (err) {
      console.error("[useMongoAuthState] writeData error", { sessionId, dataType, dataId, error: err.message });
    }
  };

  const readData = async (dataType, dataId) => {
    try {
      const doc = await WhatsAppAuthState.findOne({ sessionId, dataType, dataId }).lean();
      if (!doc || !doc.dataJson) return null;
      return JSON.parse(doc.dataJson, BufferJSON.reviver);
    } catch (err) {
      console.error("[useMongoAuthState] readData error", { sessionId, dataType, dataId, error: err.message });
      return null;
    }
  };

  const removeData = async (dataType, dataId) => {
    try {
      await WhatsAppAuthState.deleteOne({ sessionId, dataType, dataId });
    } catch (err) {
      console.error("[useMongoAuthState] removeData error", { sessionId, dataType, dataId, error: err.message });
    }
  };

  const creds = (await readData("creds", "creds")) || initAuthCreds();

  return {
    state: {
      creds,
      keys: {
        get: async (type, ids) => {
          const data = {};
          await Promise.all(
            ids.map(async (id) => {
              let value = await readData(type, id);
              if (type === "app-state-sync-key" && value) {
                value = proto.Message.AppStateSyncKeyData.fromObject(value);
              }
              data[id] = value;
            })
          );
          return data;
        },
        set: async (data) => {
          const tasks = [];
          for (const category in data) {
            for (const id in data[category]) {
              const value = data[category][id];
              tasks.push(
                value ? writeData(value, category, id) : removeData(category, id)
              );
            }
          }
          await Promise.all(tasks);
        },
      },
    },
    saveCreds: async () => {
      return writeData(creds, "creds", "creds");
    },
  };
};
