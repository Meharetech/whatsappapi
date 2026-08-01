import NumberList from "../models/NumberList.js";
import SubscriptionService from "../services/SubscriptionService.js";
import { sendSubscriptionError } from "../utils/subscription.js";

const COLORS = [
  "bg-blue-500",
  "bg-emerald-500",
  "bg-violet-500",
  "bg-amber-500",
  "bg-rose-500",
  "bg-cyan-500",
  "bg-teal-500",
];

function randomColor() {
  return COLORS[Math.floor(Math.random() * COLORS.length)];
}

function formatList(list) {
  return {
    id: list._id.toString(),
    name: list.name,
    count: list.numbers.length,
    numbers: list.numbers,
    tags: list.tags,
    color: list.color,
    variables: list.variables || [],
    contactData: list.contactData || [],
    created: list.createdAt ? list.createdAt.toISOString().slice(0, 10) : null,
  };
}

export const getLists = async (req, res) => {
  try {
    const lists = await NumberList.find({ userId: req.user._id }).sort({
      createdAt: -1,
    });
    const formattedLists = lists.map(formatList);
    res.json({ lists: formattedLists });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
};

export const createList = async (req, res) => {
  try {
    const { name, numbers = [], tags = [], color, variables = [], contactData = [] } = req.body;
    if (!name) return res.status(400).json({ error: "name is required" });

    await SubscriptionService.assertResourceLimit(req.user, "numberLists", 1);

    const list = await NumberList.create({
      userId: req.user._id,
      name,
      numbers,
      tags,
      color: color || randomColor(),
      variables,
      contactData,
    });
    res.status(201).json({ list: formatList(list) });
  } catch (err) {
    return sendSubscriptionError(res, err, "Failed to create list");
  }
};

export const getList = async (req, res) => {
  try {
    const list = await NumberList.findOne({
      _id: req.params.id,
      userId: req.user._id,
    });
    if (!list) return res.status(404).json({ error: "List not found" });
    res.json({ list: formatList(list) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

export const updateList = async (req, res) => {
  try {
    const { name, numbers, tags, color, variables, contactData } = req.body;
    const update = {};
    if (name !== undefined) update.name = name;
    if (numbers !== undefined) update.numbers = numbers;
    if (tags !== undefined) update.tags = tags;
    if (color !== undefined) update.color = color;
    if (variables !== undefined) update.variables = variables;
    if (contactData !== undefined) update.contactData = contactData;
    const list = await NumberList.findOneAndUpdate(
      { _id: req.params.id, userId: req.user._id },
      update,
      { new: true },
    );
    if (!list) return res.status(404).json({ error: "List not found" });
    res.json({ list: formatList(list) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

export const deleteList = async (req, res) => {
  try {
    const list = await NumberList.findOneAndDelete({
      _id: req.params.id,
      userId: req.user._id,
    });
    if (!list) return res.status(404).json({ error: "List not found" });
    res.json({ message: "List deleted" });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

export const duplicateList = async (req, res) => {
  try {
    const original = await NumberList.findOne({
      _id: req.params.id,
      userId: req.user._id,
    });
    if (!original) return res.status(404).json({ error: "List not found" });

    await SubscriptionService.assertResourceLimit(req.user, "numberLists", 1);

    const copy = await NumberList.create({
      userId: req.user._id,
      name: `${original.name} (copy)`,
      numbers: [...original.numbers],
      tags: [...original.tags],
      color: original.color,
    });
    res.status(201).json({ list: formatList(copy) });
  } catch (err) {
    return sendSubscriptionError(res, err, "Failed to duplicate list");
  }
};

export const mergeLists = async (req, res) => {
  try {
    const { name, listIds } = req.body;
    if (!listIds || listIds.length < 2)
      return res.status(400).json({ error: "At least 2 list IDs required" });
    const sourceLists = await NumberList.find({
      _id: { $in: listIds },
      userId: req.user._id,
    });

    await SubscriptionService.assertResourceLimit(req.user, "numberLists", 1);

    const allNumbers = [...new Set(sourceLists.flatMap((l) => l.numbers))];
    const merged = await NumberList.create({
      userId: req.user._id,
      name: name || "Merged List",
      numbers: allNumbers,
      tags: ["merged"],
      color: "bg-cyan-500",
    });
    res.status(201).json({ list: formatList(merged) });
  } catch (err) {
    return sendSubscriptionError(res, err, "Failed to merge lists");
  }
};

export const filterList = async (req, res) => {
  try {
    const {
      saveName,
      countryCode,
      numberFormat,
      removeDupes,
      addCountryCode,
      addToMissing,
    } = req.body;
    const original = await NumberList.findOne({
      _id: req.params.id,
      userId: req.user._id,
    });
    if (!original) return res.status(404).json({ error: "List not found" });

    await SubscriptionService.assertResourceLimit(req.user, "numberLists", 1);

    let numbers = [...original.numbers];

    // Step 1: Add country code to numbers missing it
    if (addCountryCode && addToMissing) {
      const codeDigits = addCountryCode.replace(/\D/g, "");
      numbers = numbers.map((n) => {
        const digits = n.replace(/\D/g, "");
        if (!digits.startsWith(codeDigits)) {
          return `${addCountryCode}${digits}`;
        }
        return n;
      });
    }

    // Step 2: Filter by country code
    if (countryCode) {
      const codeDigits = countryCode.replace(/\D/g, "");
      numbers = numbers.filter((n) =>
        n.replace(/\D/g, "").startsWith(codeDigits),
      );
    }

    // Step 3: Format filter
    if (numberFormat === "international")
      numbers = numbers.filter((n) => n.startsWith("+"));
    else if (numberFormat === "local")
      numbers = numbers.filter((n) => !n.startsWith("+"));

    // Step 4: Remove duplicates
    if (removeDupes) numbers = [...new Set(numbers)];

    const filtered = await NumberList.create({
      userId: req.user._id,
      name: saveName || `Filtered — ${original.name}`,
      numbers,
      tags: ["filtered"],
      color: "bg-teal-500",
    });
    res.status(201).json({ list: formatList(filtered) });
  } catch (err) {
    return sendSubscriptionError(res, err, "Failed to filter list");
  }
};

export default {
  getLists,
  createList,
  getList,
  updateList,
  deleteList,
  duplicateList,
  mergeLists,
  filterList,
};
