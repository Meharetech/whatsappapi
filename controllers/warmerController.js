import WarmerService from '../services/WarmerService.js';

export const createWarmerTask = async (req, res) => {
  try {
    const userId = req.user._id || req.user.id;
    const task = await WarmerService.createTask(userId, req.body);
    res.status(201).json({
      success: true,
      message: 'Warmup task created successfully',
      task,
    });
  } catch (error) {
    console.error('Error creating warmer task:', error);
    res.status(400).json({
      success: false,
      message: error.message || 'Failed to create warmup task',
    });
  }
};

export const getWarmerTasks = async (req, res) => {
  try {
    const userId = req.user._id || req.user.id;
    const tasks = await WarmerService.listTasks(userId);
    res.status(200).json({
      success: true,
      tasks,
    });
  } catch (error) {
    console.error('Error fetching warmer tasks:', error);
    res.status(500).json({
      success: false,
      message: error.message || 'Failed to fetch warmup tasks',
    });
  }
};

export const getWarmerTaskById = async (req, res) => {
  try {
    const userId = req.user._id || req.user.id;
    const task = await WarmerService.getTask(userId, req.params.id);
    res.status(200).json({
      success: true,
      task,
    });
  } catch (error) {
    console.error('Error fetching warmer task details:', error);
    res.status(404).json({
      success: false,
      message: error.message || 'Warmup task not found',
    });
  }
};

export const startWarmerTask = async (req, res) => {
  try {
    const userId = req.user._id || req.user.id;
    const task = await WarmerService.startTask(userId, req.params.id);
    res.status(200).json({
      success: true,
      message: 'Warmup task started successfully',
      task,
    });
  } catch (error) {
    console.error('Error starting warmer task:', error);
    res.status(400).json({
      success: false,
      message: error.message || 'Failed to start warmup task',
    });
  }
};

export const stopWarmerTask = async (req, res) => {
  try {
    const userId = req.user._id || req.user.id;
    const task = await WarmerService.stopTask(userId, req.params.id);
    res.status(200).json({
      success: true,
      message: 'Warmup task paused',
      task,
    });
  } catch (error) {
    console.error('Error stopping warmer task:', error);
    res.status(400).json({
      success: false,
      message: error.message || 'Failed to pause warmup task',
    });
  }
};

export const resetWarmerTask = async (req, res) => {
  try {
    const userId = req.user._id || req.user.id;
    const task = await WarmerService.resetTask(userId, req.params.id);
    res.status(200).json({
      success: true,
      message: 'Warmup task logs and stats reset',
      task,
    });
  } catch (error) {
    console.error('Error resetting warmer task:', error);
    res.status(400).json({
      success: false,
      message: error.message || 'Failed to reset warmup task',
    });
  }
};

export const deleteWarmerTask = async (req, res) => {
  try {
    const userId = req.user._id || req.user.id;
    const result = await WarmerService.deleteTask(userId, req.params.id);
    res.status(200).json(result);
  } catch (error) {
    console.error('Error deleting warmer task:', error);
    res.status(400).json({
      success: false,
      message: error.message || 'Failed to delete warmup task',
    });
  }
};
