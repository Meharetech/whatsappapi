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
          if (!ids || ids.length === 0) return data;

          try {
            const docs = await WhatsAppAuthState.find({
              sessionId,
              dataType: type,
              dataId: { $in: ids }
            }).lean();

            const docMap = new Map();
            for (const doc of docs) {
              if (doc && doc.dataJson) {
                try {
                  let value = JSON.parse(doc.dataJson, BufferJSON.reviver);
                  if (type === "app-state-sync-key" && value) {
                    value = proto.Message.AppStateSyncKeyData.fromObject(value);
                  }
                  docMap.set(doc.dataId, value);
                } catch (parseErr) {}
              }
            }

            for (const id of ids) {
              data[id] = docMap.has(id) ? docMap.get(id) : null;
            }
          } catch (err) {
            console.error("[useMongoAuthState] keys.get error:", { sessionId, type, error: err.message });
            for (const id of ids) {
              data[id] = null;
            }
          }

          return data;
        },
        set: async (data) => {
          const bulkOps = [];
          for (const category in data) {
            for (const id in data[category]) {
              const value = data[category][id];
              if (value) {
                try {
                  const dataJson = JSON.stringify(value, BufferJSON.replacer);
                  bulkOps.push({
                    updateOne: {
                      filter: { sessionId, dataType: category, dataId: id },
                      update: { $set: { dataJson } },
                      upsert: true,
                    },
                  });
                } catch (e) {}
              } else {
                bulkOps.push({
                  deleteOne: {
                    filter: { sessionId, dataType: category, dataId: id },
                  },
                });
              }
            }
          }

          if (bulkOps.length > 0) {
            try {
              await WhatsAppAuthState.bulkWrite(bulkOps, { ordered: false });
            } catch (err) {
              console.error("[useMongoAuthState] keys.set bulkWrite error:", { sessionId, error: err.message });
            }
          }
        },
      },
    },
    saveCreds: async () => {
      return writeData(creds, "creds", "creds");
    },
  };
};
