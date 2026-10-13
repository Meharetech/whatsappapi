import { CrmContact, WaChat, WhatsAppSession } from "../models/index.js";

/**
 * Standardize phone number: strips non-digit characters
 */
const cleanPhoneNumber = (phone) => {
  if (!phone) return "";
  let cleaned = String(phone).replace(/[^\d]/g, "");
  // Remove leading 0s if any
  cleaned = cleaned.replace(/^0+/, "");
  return cleaned;
};

/**
 * @desc Get CRM Contacts with filtering, pagination, search, sorting
 * @route GET /api/crm/contacts
 */
export const listContacts = async (req, res) => {
  try {
    const userId = req.user._id;
    const {
      search = "",
      customerType,
      leadStatus,
      leadSource,
      assignedAgent,
      tag,
      city,
      page = 1,
      limit = 25,
      sortBy = "lastInteraction",
      sortOrder = "desc",
    } = req.query;

    const query = { userId };

    if (customerType && customerType !== "all") {
      query.customerType = customerType;
    }
    if (leadStatus && leadStatus !== "all") {
      query.leadStatus = leadStatus;
    }
    if (leadSource && leadSource !== "all") {
      query.leadSource = leadSource;
    }
    if (assignedAgent && assignedAgent !== "all") {
      query.assignedAgent = assignedAgent;
    }
    if (city) {
      query.city = { $regex: city, $options: "i" };
    }
    if (tag) {
      query.tags = tag;
    }

    if (search.trim()) {
      const regex = { $regex: search.trim(), $options: "i" };
      query.$or = [
        { name: regex },
        { phone: regex },
        { email: regex },
        { company: regex },
        { city: regex },
        { product: regex },
        { tags: regex },
      ];
    }

    const pageNum = Math.max(1, parseInt(page, 10) || 1);
    const limitNum = Math.min(100, Math.max(1, parseInt(limit, 10) || 25));
    const skip = (pageNum - 1) * limitNum;

    const sort = {};
    sort[sortBy] = sortOrder === "asc" ? 1 : -1;

    const [contacts, total] = await Promise.all([
      CrmContact.find(query).sort(sort).skip(skip).limit(limitNum).lean(),
      CrmContact.countDocuments(query),
    ]);

    return res.json({
      success: true,
      contacts,
      total,
      page: pageNum,
      pages: Math.ceil(total / limitNum) || 1,
      limit: limitNum,
    });
  } catch (error) {
    console.error("Error listing CRM contacts:", error);
    return res.status(500).json({ error: error.message || "Failed to fetch CRM contacts" });
  }
};

/**
 * @desc Get CRM Dashboard & Pipeline Stats
 * @route GET /api/crm/stats
 */
export const getCrmStats = async (req, res) => {
  try {
    const userId = req.user._id;

    // Aggregate status counts and budgets
    const [statusAgg, typeAgg, totalPurchasesAgg, recentContacts] = await Promise.all([
      CrmContact.aggregate([
        { $match: { userId } },
        {
          $group: {
            _id: "$leadStatus",
            count: { $sum: 1 },
            totalBudget: { $sum: "$budget" },
          },
        },
      ]),
      CrmContact.aggregate([
        { $match: { userId } },
        {
          $group: {
            _id: "$customerType",
            count: { $sum: 1 },
          },
        },
      ]),
      CrmContact.aggregate([
        { $match: { userId } },
        {
          $group: {
            _id: null,
            totalRevenue: { $sum: "$totalPurchases" },
            totalPipeline: { $sum: "$budget" },
            totalContacts: { $sum: 1 },
          },
        },
      ]),
      CrmContact.find({ userId })
        .sort({ lastInteraction: -1 })
        .limit(5)
        .select("name phone company leadStatus customerType budget lastInteraction")
        .lean(),
    ]);

    // Format status map
    const statusCounts = {
      New: 0,
      Contacted: 0,
      Qualified: 0,
      "Proposal Sent": 0,
      "In Negotiation": 0,
      Won: 0,
      Lost: 0,
      Churned: 0,
    };
    let wonRevenue = 0;

    statusAgg.forEach((item) => {
      if (item._id && statusCounts.hasOwnProperty(item._id)) {
        statusCounts[item._id] = item.count;
      }
      if (item._id === "Won") {
        wonRevenue = item.totalBudget || 0;
      }
    });

    // Format type map
    const typeCounts = {
      Lead: 0,
      Prospect: 0,
      Customer: 0,
      VIP: 0,
      Partner: 0,
      Vendor: 0,
      Other: 0,
    };
    typeAgg.forEach((item) => {
      if (item._id && typeCounts.hasOwnProperty(item._id)) {
        typeCounts[item._id] = item.count;
      }
    });

    const summary = totalPurchasesAgg[0] || {
      totalRevenue: 0,
      totalPipeline: 0,
      totalContacts: 0,
    };

    const conversionRate = summary.totalContacts > 0
      ? Math.round((statusCounts.Won / summary.totalContacts) * 100)
      : 0;

    return res.json({
      success: true,
      stats: {
        totalContacts: summary.totalContacts,
        totalPipeline: summary.totalPipeline,
        wonRevenue,
        totalRevenue: summary.totalRevenue,
        conversionRate,
        statusCounts,
        typeCounts,
        recentContacts,
      },
    });
  } catch (error) {
    console.error("Error fetching CRM stats:", error);
    return res.status(500).json({ error: error.message || "Failed to fetch CRM statistics" });
  }
};

/**
 * @desc Get single contact by ID
 * @route GET /api/crm/contacts/:id
 */
export const getContact = async (req, res) => {
  try {
    const userId = req.user._id;
    const contact = await CrmContact.findOne({ _id: req.params.id, userId });
    if (!contact) {
      return res.status(404).json({ error: "Contact not found" });
    }
    return res.json({ success: true, contact });
  } catch (error) {
    console.error("Error getting CRM contact:", error);
    return res.status(500).json({ error: error.message || "Failed to get contact" });
  }
};

/**
 * @desc Create new CRM Contact
 * @route POST /api/crm/contacts
 */
export const createContact = async (req, res) => {
  try {
    const userId = req.user._id;
    const {
      name,
      phone,
      email,
      company,
      address,
      city,
      state,
      country = "India",
      customerType = "Lead",
      leadStatus = "New",
      leadSource = "Manual Entry",
      assignedAgent,
      budget = 0,
      currency = "INR",
      product,
      requirement,
      expectedClosingDate,
      tags = [],
      customFields = {},
      notes = [],
      totalPurchases = 0,
      sessionId,
    } = req.body;

    if (!name || !name.trim()) {
      return res.status(400).json({ error: "Contact name is required" });
    }
    if (!phone || !phone.trim()) {
      return res.status(400).json({ error: "WhatsApp phone number is required" });
    }

    const cleanPhone = cleanPhoneNumber(phone);
    if (!cleanPhone || cleanPhone.length < 7) {
      return res.status(400).json({ error: "Please enter a valid phone number" });
    }

    // Check duplicate
    const existing = await CrmContact.findOne({ userId, phone: cleanPhone });
    if (existing) {
      return res.status(400).json({
        error: `A contact with phone +${cleanPhone} already exists (${existing.name}).`,
        contactId: existing._id,
      });
    }

    const chatJid = `${cleanPhone}@s.whatsapp.net`;

    // Format notes if provided
    const initialNotes = [];
    if (typeof notes === "string" && notes.trim()) {
      initialNotes.push({
        note: notes.trim(),
        createdBy: req.user.name || "User",
        createdAt: new Date(),
      });
    } else if (Array.isArray(notes)) {
      notes.forEach((n) => {
        if (typeof n === "string" && n.trim()) {
          initialNotes.push({ note: n.trim(), createdBy: req.user.name || "User" });
        } else if (n && n.note) {
          initialNotes.push({
            note: n.note,
            createdBy: n.createdBy || req.user.name || "User",
            createdAt: n.createdAt || new Date(),
          });
        }
      });
    }

    // Parse customFields
    const formattedCustomFields = {};
    if (customFields && typeof customFields === "object") {
      Object.keys(customFields).forEach((k) => {
        if (k && customFields[k] !== undefined) {
          formattedCustomFields[k] = String(customFields[k]);
        }
      });
    }

    const newContact = await CrmContact.create({
      userId,
      sessionId: sessionId || null,
      name: name.trim(),
      phone: cleanPhone,
      chatJid,
      email: (email || "").trim(),
      company: (company || "").trim(),
      address: (address || "").trim(),
      city: (city || "").trim(),
      state: (state || "").trim(),
      country: (country || "India").trim(),
      customerType,
      leadStatus,
      leadSource,
      assignedAgent: (assignedAgent || "").trim(),
      budget: Number(budget) || 0,
      currency: currency || "INR",
      product: (product || "").trim(),
      requirement: (requirement || "").trim(),
      expectedClosingDate: expectedClosingDate ? new Date(expectedClosingDate) : null,
      totalPurchases: Number(totalPurchases) || 0,
      totalConversations: 0,
      lastInteraction: new Date(),
      tags: Array.isArray(tags) ? tags.map((t) => String(t).trim()).filter(Boolean) : [],
      notes: initialNotes,
      customFields: formattedCustomFields,
    });

    return res.status(201).json({
      success: true,
      message: "Contact created successfully",
      contact: newContact,
    });
  } catch (error) {
    console.error("Error creating CRM contact:", error);
    return res.status(500).json({ error: error.message || "Failed to create contact" });
  }
};

/**
 * @desc Update existing CRM contact
 * @route PUT /api/crm/contacts/:id
 */
export const updateContact = async (req, res) => {
  try {
    const userId = req.user._id;
    const { id } = req.params;

    const contact = await CrmContact.findOne({ _id: id, userId });
    if (!contact) {
      return res.status(404).json({ error: "Contact not found" });
    }

    const {
      name,
      phone,
      email,
      company,
      address,
      city,
      state,
      country,
      customerType,
      leadStatus,
      leadSource,
      assignedAgent,
      budget,
      currency,
      product,
      requirement,
      expectedClosingDate,
      totalPurchases,
      tags,
      customFields,
    } = req.body;

    if (name !== undefined) contact.name = name.trim();
    if (email !== undefined) contact.email = email.trim();
    if (company !== undefined) contact.company = company.trim();
    if (address !== undefined) contact.address = address.trim();
    if (city !== undefined) contact.city = city.trim();
    if (state !== undefined) contact.state = state.trim();
    if (country !== undefined) contact.country = country.trim();
    if (customerType !== undefined) contact.customerType = customerType;
    if (leadStatus !== undefined) contact.leadStatus = leadStatus;
    if (leadSource !== undefined) contact.leadSource = leadSource;
    if (assignedAgent !== undefined) contact.assignedAgent = assignedAgent.trim();
    if (budget !== undefined) contact.budget = Number(budget) || 0;
    if (currency !== undefined) contact.currency = currency;
    if (product !== undefined) contact.product = product.trim();
    if (requirement !== undefined) contact.requirement = requirement.trim();
    if (expectedClosingDate !== undefined) {
      contact.expectedClosingDate = expectedClosingDate ? new Date(expectedClosingDate) : null;
    }
    if (totalPurchases !== undefined) contact.totalPurchases = Number(totalPurchases) || 0;

    if (phone !== undefined) {
      const cleanPhone = cleanPhoneNumber(phone);
      if (cleanPhone && cleanPhone !== contact.phone) {
        // Ensure no other contact has this phone
        const existing = await CrmContact.findOne({
          userId,
          phone: cleanPhone,
          _id: { $ne: id },
        });
        if (existing) {
          return res.status(400).json({
            error: `Another contact already exists with phone +${cleanPhone}`,
          });
        }
        contact.phone = cleanPhone;
        contact.chatJid = `${cleanPhone}@s.whatsapp.net`;
      }
    }

    if (Array.isArray(tags)) {
      contact.tags = tags.map((t) => String(t).trim()).filter(Boolean);
    }

    if (customFields && typeof customFields === "object") {
      Object.keys(customFields).forEach((key) => {
        contact.customFields.set(key, String(customFields[key]));
      });
    }

    await contact.save();

    return res.json({
      success: true,
      message: "Contact updated successfully",
      contact,
    });
  } catch (error) {
    console.error("Error updating CRM contact:", error);
    return res.status(500).json({ error: error.message || "Failed to update contact" });
  }
};

/**
 * @desc Delete CRM contact
 * @route DELETE /api/crm/contacts/:id
 */
export const deleteContact = async (req, res) => {
  try {
    const userId = req.user._id;
    const { id } = req.params;

    const deleted = await CrmContact.findOneAndDelete({ _id: id, userId });
    if (!deleted) {
      return res.status(404).json({ error: "Contact not found" });
    }

    return res.json({ success: true, message: "Contact deleted successfully" });
  } catch (error) {
    console.error("Error deleting CRM contact:", error);
    return res.status(500).json({ error: error.message || "Failed to delete contact" });
  }
};

/**
 * @desc Bulk Delete CRM Contacts
 * @route POST /api/crm/contacts/bulk-delete
 */
export const bulkDeleteContacts = async (req, res) => {
  try {
    const userId = req.user._id;
    const { contactIds } = req.body;

    if (!Array.isArray(contactIds) || contactIds.length === 0) {
      return res.status(400).json({ error: "No contact IDs provided" });
    }

    const result = await CrmContact.deleteMany({
      _id: { $in: contactIds },
      userId,
    });

    return res.json({
      success: true,
      message: `${result.deletedCount} contacts deleted successfully`,
      deletedCount: result.deletedCount,
    });
  } catch (error) {
    console.error("Error bulk deleting CRM contacts:", error);
    return res.status(500).json({ error: error.message || "Failed to bulk delete contacts" });
  }
};

/**
 * @desc Delete All CRM Contacts (or matching current filter)
 * @route POST /api/crm/contacts/delete-all
 */
export const deleteAllContacts = async (req, res) => {
  try {
    const userId = req.user._id;
    const { leadStatus, customerType, leadSource } = req.body || {};

    const query = { userId };
    if (leadStatus && leadStatus !== "all") query.leadStatus = leadStatus;
    if (customerType && customerType !== "all") query.customerType = customerType;
    if (leadSource && leadSource !== "all") query.leadSource = leadSource;

    const result = await CrmContact.deleteMany(query);

    return res.json({
      success: true,
      message: `Successfully deleted ${result.deletedCount} contacts.`,
      deletedCount: result.deletedCount,
    });
  } catch (error) {
    console.error("Error deleting all CRM contacts:", error);
    return res.status(500).json({ error: error.message || "Failed to delete contacts" });
  }
};

/**
 * @desc Bulk Update Status / Agent
 * @route POST /api/crm/contacts/bulk-update
 */
export const bulkUpdateContacts = async (req, res) => {
  try {
    const userId = req.user._id;
    const { contactIds, updates } = req.body;

    if (!Array.isArray(contactIds) || contactIds.length === 0) {
      return res.status(400).json({ error: "No contact IDs provided" });
    }

    const allowedUpdates = {};
    if (updates.leadStatus) allowedUpdates.leadStatus = updates.leadStatus;
    if (updates.customerType) allowedUpdates.customerType = updates.customerType;
    if (updates.assignedAgent !== undefined) allowedUpdates.assignedAgent = updates.assignedAgent;
    if (updates.tagToAdd) {
      await CrmContact.updateMany(
        { _id: { $in: contactIds }, userId },
        { $addToSet: { tags: updates.tagToAdd } }
      );
    }

    if (Object.keys(allowedUpdates).length > 0) {
      await CrmContact.updateMany(
        { _id: { $in: contactIds }, userId },
        { $set: allowedUpdates }
      );
    }

    return res.json({
      success: true,
      message: `${contactIds.length} contacts updated successfully`,
    });
  } catch (error) {
    console.error("Error bulk updating CRM contacts:", error);
    return res.status(500).json({ error: error.message || "Failed to bulk update contacts" });
  }
};

/**
 * @desc Add Note to Contact
 * @route POST /api/crm/contacts/:id/notes
 */
export const addContactNote = async (req, res) => {
  try {
    const userId = req.user._id;
    const { id } = req.params;
    const { note } = req.body;

    if (!note || !note.trim()) {
      return res.status(400).json({ error: "Note content cannot be empty" });
    }

    const contact = await CrmContact.findOne({ _id: id, userId });
    if (!contact) {
      return res.status(404).json({ error: "Contact not found" });
    }

    const newNote = {
      note: note.trim(),
      createdBy: req.user.name || "User",
      createdAt: new Date(),
    };

    contact.notes.unshift(newNote);
    await contact.save();

    return res.json({
      success: true,
      message: "Note added successfully",
      notes: contact.notes,
    });
  } catch (error) {
    console.error("Error adding CRM contact note:", error);
    return res.status(500).json({ error: error.message || "Failed to add note" });
  }
};

/**
 * @desc Delete Note from Contact
 * @route DELETE /api/crm/contacts/:id/notes/:noteId
 */
export const deleteContactNote = async (req, res) => {
  try {
    const userId = req.user._id;
    const { id, noteId } = req.params;

    const contact = await CrmContact.findOne({ _id: id, userId });
    if (!contact) {
      return res.status(404).json({ error: "Contact not found" });
    }

    contact.notes = contact.notes.filter((n) => n._id.toString() !== noteId);
    await contact.save();

    return res.json({
      success: true,
      message: "Note deleted successfully",
      notes: contact.notes,
    });
  } catch (error) {
    console.error("Error deleting CRM contact note:", error);
    return res.status(500).json({ error: error.message || "Failed to delete note" });
  }
};

/**
 * @desc Auto-import contacts from existing WhatsApp chats
 * "Every WhatsApp number can become a CRM contact"
 * @route POST /api/crm/import-from-chats
 */
export const importFromChats = async (req, res) => {
  try {
    const userId = req.user._id;
    const { sessionId } = req.body;

    const chatQuery = {
      userId,
      isGroup: false, // only direct 1-to-1 contacts
    };
    if (sessionId) {
      chatQuery.sessionId = sessionId;
    }

    const chats = await WaChat.find(chatQuery).sort({ lastMessageTime: -1 }).lean();

    if (!chats || chats.length === 0) {
      return res.json({
        success: true,
        message: "No direct WhatsApp chats found to import",
        importedCount: 0,
        totalScanned: 0,
      });
    }

    let importedCount = 0;
    let updatedCount = 0;

    for (const chat of chats) {
      const cleanPhone = cleanPhoneNumber(chat.phoneNumber || chat.chatJid);
      if (!cleanPhone || cleanPhone.length < 7) continue;

      const chatJid = chat.chatJid || `${cleanPhone}@s.whatsapp.net`;
      const contactName =
        (chat.name && !chat.name.startsWith("+") && !chat.name.includes("@") ? chat.name : null) ||
        chat.contactName ||
        `+${cleanPhone}`;

      // Check if contact already exists
      const existing = await CrmContact.findOne({ userId, phone: cleanPhone });

      if (!existing) {
        await CrmContact.create({
          userId,
          sessionId: chat.sessionId || null,
          name: contactName,
          phone: cleanPhone,
          chatJid,
          customerType: "Lead",
          leadStatus: "New",
          leadSource: "WhatsApp Inbound",
          lastInteraction: chat.lastMessageTime || chat.updatedAt || new Date(),
          lastInteractionText: (chat.lastMessage || "").slice(0, 500),
          totalConversations: 1,
        });
        importedCount++;
      } else {
        // Sync interaction time and update name if previously default
        let shouldSave = false;
        if (
          chat.lastMessageTime &&
          (!existing.lastInteraction || new Date(chat.lastMessageTime) > new Date(existing.lastInteraction))
        ) {
          existing.lastInteraction = chat.lastMessageTime;
          existing.lastInteractionText = (chat.lastMessage || "").slice(0, 500);
          shouldSave = true;
        }
        if (
          existing.name.startsWith("+") &&
          contactName &&
          !contactName.startsWith("+")
        ) {
          existing.name = contactName;
          shouldSave = true;
        }
        if (shouldSave) {
          await existing.save();
          updatedCount++;
        }
      }
    }

    return res.json({
      success: true,
      message: `Successfully imported ${importedCount} new CRM contacts (${updatedCount} updated).`,
      importedCount,
      updatedCount,
      totalScanned: chats.length,
    });
  } catch (error) {
    console.error("Error importing CRM contacts from chats:", error);
    return res.status(500).json({ error: error.message || "Failed to import contacts from chats" });
  }
};

/**
 * @desc Export CRM Contacts as CSV
 * @route GET /api/crm/export
 */
export const exportContacts = async (req, res) => {
  try {
    const userId = req.user._id;
    const { customerType, leadStatus, leadSource } = req.query;

    const query = { userId };
    if (customerType && customerType !== "all") query.customerType = customerType;
    if (leadStatus && leadStatus !== "all") query.leadStatus = leadStatus;
    if (leadSource && leadSource !== "all") query.leadSource = leadSource;

    const contacts = await CrmContact.find(query).sort({ createdAt: -1 }).lean();

    const headers = [
      "Customer Name",
      "WhatsApp Number",
      "Email",
      "Company",
      "Customer Type",
      "Lead Status",
      "Lead Source",
      "Assigned Agent",
      "Deal Budget",
      "Currency",
      "Product",
      "Requirement",
      "Expected Closing Date",
      "City",
      "State",
      "Country",
      "Total Purchases",
      "Total Conversations",
      "Tags",
      "Last Interaction Date",
      "Last Interaction Message",
      "Created At",
    ];

    const escapeCsv = (str) => {
      if (str === null || str === undefined) return '""';
      const escaped = String(str).replace(/"/g, '""');
      return `"${escaped}"`;
    };

    const rows = contacts.map((c) => [
      escapeCsv(c.name),
      escapeCsv(`+${c.phone}`),
      escapeCsv(c.email),
      escapeCsv(c.company),
      escapeCsv(c.customerType),
      escapeCsv(c.leadStatus),
      escapeCsv(c.leadSource),
      escapeCsv(c.assignedAgent),
      c.budget || 0,
      escapeCsv(c.currency || "INR"),
      escapeCsv(c.product),
      escapeCsv(c.requirement),
      escapeCsv(c.expectedClosingDate ? new Date(c.expectedClosingDate).toISOString().split("T")[0] : ""),
      escapeCsv(c.city),
      escapeCsv(c.state),
      escapeCsv(c.country),
      c.totalPurchases || 0,
      c.totalConversations || 0,
      escapeCsv((c.tags || []).join(", ")),
      escapeCsv(c.lastInteraction ? new Date(c.lastInteraction).toISOString() : ""),
      escapeCsv(c.lastInteractionText || ""),
      escapeCsv(c.createdAt ? new Date(c.createdAt).toISOString() : ""),
    ]);

    const csvContent = [headers.join(","), ...rows.map((r) => r.join(","))].join("\r\n");

    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename=crm_contacts_${Date.now()}.csv`);
    return res.status(200).send(csvContent);
  } catch (error) {
    console.error("Error exporting CRM contacts:", error);
    return res.status(500).json({ error: error.message || "Failed to export contacts" });
  }
};
