require('dotenv').config();
const express = require('express');
const { Client, middleware } = require('@line/bot-sdk');
const sqlite3 = require('sqlite3').verbose();
const OpenAI = require('openai');
const jwt = require('jsonwebtoken');
const cron = require('node-cron');

const app = express();
const port = process.env.PORT || 3000;

// Line Bot 設定
const config = {
  channelAccessToken: process.env.CHANNEL_ACCESS_TOKEN,
  channelSecret: process.env.CHANNEL_SECRET,
};
const client = new Client(config);

// OpenAI 設定
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

// 資料庫初始化
const db = new sqlite3.Database('./enterprise_tasks.db');
db.serialize(() => {
  // 任務表
  db.run(`CREATE TABLE IF NOT EXISTS tasks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    scope_type TEXT NOT NULL,
    scope_id TEXT NOT NULL,
    creator_id TEXT NOT NULL,
    creator_name TEXT,
    assignee_id TEXT,
    assignee_name TEXT,
    task_content TEXT NOT NULL,
    priority TEXT DEFAULT 'normal',
    status TEXT DEFAULT 'pending',
    due_date DATE,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    completed_at DATETIME NULL
  )`);

  // 用戶權限表
  db.run(`CREATE TABLE IF NOT EXISTS user_permissions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id TEXT NOT NULL UNIQUE,
    user_name TEXT,
    role TEXT DEFAULT 'member',
    department TEXT,
    managed_groups TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);

  // 會議記錄表
  db.run(`CREATE TABLE IF NOT EXISTS meeting_sessions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    scope_type TEXT NOT NULL,
    scope_id TEXT NOT NULL,
    session_start DATETIME,
    session_end DATETIME,
    is_active BOOLEAN DEFAULT false,
    recorded_messages TEXT,
    extracted_tasks TEXT
  )`);

  // 任務互動記錄表
  db.run(`CREATE TABLE IF NOT EXISTS task_interactions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    task_id INTEGER,
    user_id TEXT,
    action_type TEXT,
    message TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (task_id) REFERENCES tasks (id)
  )`);
});

// 權限等級定義
const ROLES = {
  SUPER_ADMIN: 'super_admin',
  DEPARTMENT_MANAGER: 'dept_manager',
  GROUP_ADMIN: 'group_admin',
  MEMBER: 'member'
};

// 獲取對話範圍 ID
function getScopeId(event) {
  if (event.source.type === 'group') {
    return { type: 'group', id: event.source.groupId };
  } else if (event.source.type === 'room') {
    return { type: 'room', id: event.source.roomId };
  } else {
    return { type: 'user', id: event.source.userId };
  }
}

// 獲取用戶權限
function getUserPermission(userId) {
  return new Promise((resolve, reject) => {
    db.get('SELECT * FROM user_permissions WHERE user_id = ?', [userId], (err, row) => {
      if (err) reject(err);
      else resolve(row || { role: ROLES.MEMBER });
    });
  });
}

// AI 智能任務提取（靜默模式）
async function extractTasksSilently(messages) {
  try {
    const response = await openai.chat.completions.create({
      model: "gpt-4",
      messages: [
        {
          role: "system",
          content: `你是企業會議任務提取專家。分析對話內容，提取出明確的任務、行動項目和責任分配。
輸出格式為 JSON：
{
  "tasks": [
    {
      "content": "任務描述",
      "assignee": "負責人姓名",
      "priority": "high|normal|low",
      "due_date": "預計完成日期",
      "type": "任務類型"
    }
  ]
}
只提取明確的任務，忽略閒聊和討論性內容。`
        },
        {
          role: "user",
          content: `請分析以下會議對話並提取任務：\n\n${messages}`
        }
      ],
      max_tokens: 1000,
      temperature: 0.3
    });

    const result = JSON.parse(response.choices[0].message.content);
    return result.tasks || [];
  } catch (error) {
    console.error('AI 任務提取錯誤:', error);
    return [];
  }
}

// 靜默會議記錄功能
const meetingSessions = new Map();

function startMeetingSession(scopeId, scopeType) {
  const sessionKey = `${scopeType}_${scopeId}`;
  meetingSessions.set(sessionKey, {
    messages: [],
    startTime: new Date(),
    isActive: true
  });
}

function addMessageToSession(scopeId, scopeType, userId, message, displayName) {
  const sessionKey = `${scopeType}_${scopeId}`;
  const session = meetingSessions.get(sessionKey);
  
  if (session && session.isActive) {
    session.messages.push({
      userId,
      displayName: displayName || '未知用戶',
      message,
      timestamp: new Date()
    });
  }
}

// 任務管理功能
function createTask(scopeType, scopeId, creatorId, creatorName, taskData) {
  return new Promise((resolve, reject) => {
    db.run(
      `INSERT INTO tasks (scope_type, scope_id, creator_id, creator_name, assignee_id, assignee_name, task_content, priority, due_date) 
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [scopeType, scopeId, creatorId, creatorName, taskData.assignee_id, taskData.assignee_name, 
       taskData.content, taskData.priority, taskData.due_date],
      function(err) {
        if (err) reject(err);
        else resolve(this.lastID);
      }
    );
  });
}

function getTasks(scopeType, scopeId, filter = 'all') {
  return new Promise((resolve, reject) => {
    let query = 'SELECT * FROM tasks WHERE scope_type = ? AND scope_id = ?';
    const params = [scopeType, scopeId];
    
    if (filter === 'pending') {
      query += ' AND status = "pending"';
    } else if (filter === 'completed') {
      query += ' AND status = "completed"';
    } else if (filter === 'overdue') {
      query += ' AND status = "pending" AND due_date < date("now")';
    }
    
    query += ' ORDER BY priority DESC, created_at DESC';
    
    db.all(query, params, (err, rows) => {
      if (err) reject(err);
      else resolve(rows);
    });
  });
}

// 跨群組任務查詢（管理者功能）
function getCrossGroupTasks(userId, userRole) {
  return new Promise((resolve, reject) => {
    let query = 'SELECT * FROM tasks';
    let params = [];

    if (userRole === ROLES.SUPER_ADMIN) {
      // 超級管理員可以看所有任務
      query += ' ORDER BY priority DESC, created_at DESC';
    } else if (userRole === ROLES.DEPARTMENT_MANAGER) {
      // 部門管理員只能看指定部門的任務
      query += ' WHERE scope_id IN (SELECT group_id FROM user_groups WHERE department = ?)';
      params = [userDepartment]; // 需要從用戶資料取得部門
    } else {
      // 一般用戶只能看自己相關的任務
      query += ' WHERE creator_id = ? OR assignee_id = ?';
      params = [userId, userId];
    }

    db.all(query, params, (err, rows) => {
      if (err) reject(err);
      else resolve(rows);
    });
  });
}

// 訊息處理主函數
async function handleEvent(event) {
  if (event.type !== 'message' || event.message.type !== 'text') {
    return Promise.resolve(null);
  }

  const scope = getScopeId(event);
  const userId = event.source.userId;
  const message = event.message.text.trim();
  const userPermission = await getUserPermission(userId);

  // 獲取用戶顯示名稱
  let displayName = '未知用戶';
  try {
    if (scope.type === 'group') {
      const profile = await client.getGroupMemberProfile(scope.id, userId);
      displayName = profile.displayName;
    } else {
      const profile = await client.getProfile(userId);
      displayName = profile.displayName;
    }
  } catch (error) {
    console.log('無法獲取用戶名稱');
  }

  // 靜默會議記錄
  if (scope.type === 'group' || scope.type === 'room') {
    addMessageToSession(scope.id, scope.type, userId, message, displayName);
  }

  try {
    // 會議控制指令
    if (message === '開始會議' || message === '會議開始') {
      if (userPermission.role === ROLES.GROUP_ADMIN || 
          userPermission.role === ROLES.DEPARTMENT_MANAGER || 
          userPermission.role === ROLES.SUPER_ADMIN) {
        startMeetingSession(scope.id, scope.type);
        return client.replyMessage(event.replyToken, {
          type: 'text',
          text: '📝 會議記錄已開始\n\n🤫 我將靜默記錄對話內容\n會議結束後請使用「會議總結」查看任務清單'
        });
      }
    }

    // 會議總結指令
    if (message === '會議總結' || message === '總結任務' || message.includes('TaskBot 會議總結')) {
      const sessionKey = `${scope.type}_${scope.id}`;
      const session = meetingSessions.get(sessionKey);

      if (!session || session.messages.length === 0) {
        return client.replyMessage(event.replyToken, {
          type: 'text',
          text: '❌ 找不到會議記錄\n\n請先使用「開始會議」啟動會議記錄功能'
        });
      }

      // 結束會議記錄
      session.isActive = false;

      // 提取對話內容
      const dialogueText = session.messages
        .map(msg => `${msg.displayName}：${msg.message}`)
        .join('\n');

      // AI 提取任務
      const extractedTasks = await extractTasksSilently(dialogueText);

      if (extractedTasks.length === 0) {
        return client.replyMessage(event.replyToken, {
          type: 'text',
          text: '📋 會議總結完成\n\n未檢測到明確的任務或行動項目\n如有需要，請手動新增任務'
        });
      }

      // 儲存任務到資料庫
      const taskPromises = extractedTasks.map(task => 
        createTask(scope.type, scope.id, userId, displayName, {
          content: task.content,
          assignee_name: task.assignee,
          priority: task.priority,
          due_date: task.due_date
        })
      );

      await Promise.all(taskPromises);

      // 生成總結回覆
      const endTime = new Date();
      const duration = Math.round((endTime - session.startTime) / 60000);

      let summary = `📋 會議任務總結 (${session.startTime.toLocaleDateString()} ${session.startTime.toLocaleTimeString().slice(0,5)}-${endTime.toLocaleTimeString().slice(0,5)})\n`;
      summary += `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n`;

      extractedTasks.forEach((task, index) => {
        const priorityEmoji = task.priority === 'high' ? '🔴' : 
                              task.priority === 'low' ? '🟢' : '🟡';
        summary += `${index + 1}. 📝 ${task.content}\n`;
        summary += ` 👤 ${task.assignee || '待分配'} | ${priorityEmoji} ${task.priority === 'high' ? '高' : task.priority === 'low' ? '低' : '中'}優先級\n`;
        if (task.due_date) {
          summary += ` ⏰ 預計：${task.due_date}\n`;
        }
        summary += `\n`;
      });

      summary += `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`;
      summary += `✅ 任務已同步給所有群組成員！\n`;
      summary += `👍 請相關人員確認接受任務\n`;
      summary += `📊 會議時長：${duration} 分鐘`;

      // 清除會議記錄
      meetingSessions.delete(sessionKey);

      return client.replyMessage(event.replyToken, {
        type: 'text',
        text: summary
      });
    }

    // 管理者跨群組查詢
    if (message.includes('全公司狀態') || message.includes('部門狀態')) {
      if (userPermission.role !== ROLES.SUPER_ADMIN && 
          userPermission.role !== ROLES.DEPARTMENT_MANAGER) {
        return client.replyMessage(event.replyToken, {
          type: 'text',
          text: '❌ 權限不足\n\n此功能僅限管理者使用'
        });
      }

      const allTasks = await getCrossGroupTasks(userId, userPermission.role);
      const totalTasks = allTasks.length;
      const completedTasks = allTasks.filter(t => t.status === 'completed').length;
      const overdueTasks = allTasks.filter(t => 
        t.status === 'pending' && t.due_date && new Date(t.due_date) < new Date()
      ).length;
      const completionRate = totalTasks > 0 ? Math.round((completedTasks / totalTasks) * 100) : 0;

      let report = `📊 ${userPermission.role === ROLES.SUPER_ADMIN ? '全公司' : '部門'}任務概況 (${new Date().toLocaleDateString()})\n`;
      report += `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n`;
      report += `📈 整體統計：\n`;
      report += `📝 總任務數：${totalTasks} 項\n`;
      report += `✅ 已完成：${completedTasks} 項 (${completionRate}%)\n`;
      report += `⏳ 進行中：${totalTasks - completedTasks - overdueTasks} 項\n`;
      report += `🔴 逾期任務：${overdueTasks} 項\n\n`;

      if (overdueTasks > 0) {
        report += `🚨 需要關注的逾期任務：\n`;
        const overdueList = allTasks
          .filter(t => t.status === 'pending' && t.due_date && new Date(t.due_date) < new Date())
          .slice(0, 5);
        
        overdueList.forEach(task => {
          const overdueDays = Math.floor((new Date() - new Date(task.due_date)) / (1000 * 60 * 60 * 24));
          report += `• ${task.task_content} - 逾期 ${overdueDays} 天\n`;
        });
      }

      return client.replyMessage(event.replyToken, {
        type: 'text',
        text: report
      });
    }

    // 任務查詢指令
    if (message === '任務' || message === '查看任務' || message === '任務列表') {
      const tasks = await getTasks(scope.type, scope.id);
      
      if (tasks.length === 0) {
        return client.replyMessage(event.replyToken, {
          type: 'text',
          text: '📝 目前沒有任何任務\n\n💡 使用「開始會議」開啟會議記錄模式\n或直接新增任務內容'
        });
      }

      let response = `📋 ${scope.type === 'group' ? '群組' : '個人'}任務列表：\n\n`;
      tasks.forEach((task, index) => {
        const status = task.status === 'completed' ? '✅' : 
                      (task.due_date && new Date(task.due_date) < new Date()) ? '🔴' : '⏳';
        const priority = task.priority === 'high' ? '🔴' : 
                        task.priority === 'low' ? '🟢' : '🟡';
        
        response += `${index + 1}. ${status}${priority} ${task.task_content}\n`;
        response += ` 👤 ${task.assignee_name || task.creator_name} | 📅 ${task.created_at.split(' ')[0]}\n`;
        if (task.due_date) {
          response += ` ⏰ 截止：${task.due_date}\n`;
        }
        response += `\n`;
      });

      response += `💡 管理指令：\n`;
      response += `• 完成 [編號] - 標記任務完成\n`;
      response += `• 刪除 [編號] - 刪除任務\n`;
      response += `• 統計 - 查看任務統計`;

      return client.replyMessage(event.replyToken, {
        type: 'text',
        text: response
      });
    }

    // 任務統計
    if (message === '統計' || message === '任務統計') {
      const allTasks = await getTasks(scope.type, scope.id);
      const completed = allTasks.filter(t => t.status === 'completed').length;
      const pending = allTasks.filter(t => t.status === 'pending').length;
      const overdue = allTasks.filter(t => 
        t.status === 'pending' && t.due_date && new Date(t.due_date) < new Date()
      ).length;
      const high = allTasks.filter(t => t.priority === 'high' && t.status === 'pending').length;
      const completionRate = allTasks.length > 0 ? Math.round((completed / allTasks.length) * 100) : 0;

      return client.replyMessage(event.replyToken, {
        type: 'text',
        text: `📊 任務統計報告：\n\n✅ 已完成：${completed} 個\n⏳ 進行中：${pending} 個\n🔴 逾期：${overdue} 個\n🚨 高優先級：${high} 個\n📝 總計：${allTasks.length} 個\n\n📈 完成率：${completionRate}%\n🎯 ${completionRate >= 80 ? '表現優秀！' : '還需加油！'}`
      });
    }

    // 完成任務
    if (message.startsWith('完成 ')) {
      const taskNumber = parseInt(message.replace('完成 ', ''));
      const tasks = await getTasks(scope.type, scope.id);
      
      if (taskNumber > 0 && taskNumber <= tasks.length) {
        const task = tasks[taskNumber - 1];
        
        if (task.status === 'completed') {
          return client.replyMessage(event.replyToken, {
            type: 'text',
            text: `ℹ️ 這個任務已經完成了！\n\n"${task.task_content}"`
          });
        }

        // 更新任務狀態
        await new Promise((resolve, reject) => {
          db.run('UPDATE tasks SET status = "completed", completed_at = CURRENT_TIMESTAMP WHERE id = ?', 
            [task.id], function(err) {
              if (err) reject(err);
              else resolve();
            }
          );
        });

        // 記錄互動
        await new Promise((resolve, reject) => {
          db.run('INSERT INTO task_interactions (task_id, user_id, action_type, message) VALUES (?, ?, ?, ?)',
            [task.id, userId, 'complete', `${displayName} 完成了任務`],
            function(err) {
              if (err) reject(err);
              else resolve();
            }
          );
        });

        return client.replyMessage(event.replyToken, {
          type: 'text',
          text: `🎉 恭喜！任務已完成！\n\n✅ "${task.task_content}"\n👤 完成者：${displayName}\n⏰ 完成時間：${new Date().toLocaleString()}\n\n🏆 又朝目標邁進了一步！`
        });
      }
      
      return client.replyMessage(event.replyToken, {
        type: 'text',
        text: '❌ 找不到該任務編號\n\n💡 使用「任務」查看所有任務編號'
      });
    }

    // 權限管理指令（僅超級管理員）
    if (message.startsWith('設定權限 ') && userPermission.role === ROLES.SUPER_ADMIN) {
      const parts = message.split(' ');
      if (parts.length >= 3) {
        const targetUserId = parts[1];
        const newRole = parts[2];

        await new Promise((resolve, reject) => {
          db.run('INSERT OR REPLACE INTO user_permissions (user_id, role) VALUES (?, ?)',
            [targetUserId, newRole],
            function(err) {
              if (err) reject(err);
              else resolve();
            }
          );
        });

        return client.replyMessage(event.replyToken, {
          type: 'text',
          text: `✅ 權限設定完成\n\n👤 用戶：${targetUserId}\n🔐 角色：${newRole}`
        });
      }
    }

    // 幫助指令
    if (message === '幫助' || message === 'help' || message === '指令') {
      let helpText = `🤖 企業任務管理機器人\n\n`;
      helpText += `📝 會議功能：\n`;
      helpText += `• 開始會議 - 啟動靜默記錄\n`;
      helpText += `• 會議總結 - 提取並分配任務\n\n`;
      helpText += `📋 任務管理：\n`;
      helpText += `• 任務 - 查看任務列表\n`;
      helpText += `• 完成 [編號] - 標記完成\n`;
      helpText += `• 統計 - 查看統計資料\n\n`;

      if (userPermission.role === ROLES.SUPER_ADMIN || userPermission.role === ROLES.DEPARTMENT_MANAGER) {
        helpText += `👑 管理功能：\n`;
        helpText += `• 全公司狀態 - 跨群組監控\n`;
        helpText += `• 部門狀態 - 部門任務概況\n\n`;
      }

      helpText += `💡 特色功能：\n`;
      helpText += `• 🤫 靜默會議記錄\n`;
      helpText += `• 🤖 AI 智能任務提取\n`;
      helpText += `• 👥 企業級權限管理\n`;
      helpText += `• 📊 跨群組任務監控`;

      return client.replyMessage(event.replyToken, {
        type: 'text',
        text: helpText
      });
    }

    // 如果沒有匹配的指令，且在會議進行中，則靜默記錄
    return Promise.resolve(null);

  } catch (error) {
    console.error('處理訊息錯誤:', error);
    return client.replyMessage(event.replyToken, {
      type: 'text',
      text: '😅 系統暫時忙碌中，請稍後再試！'
    });
  }
}

// 定時提醒系統
cron.schedule('0 9 * * 1-5', () => {
  // 每週一到週五上午 9 點檢查逾期任務
  db.all('SELECT * FROM tasks WHERE status = "pending" AND due_date < date("now")', (err, overdueTasks) => {
    if (err) return;

    overdueTasks.forEach(task => {
      const message = `🔔 任務逾期提醒\n\n📝 ${task.task_content}\n👤 負責人：${task.assignee_name || task.creator_name}\n⏰ 原定截止：${task.due_date}`;
      
      // 發送提醒到原群組
      if (task.scope_type === 'group') {
        client.pushMessage(task.scope_id, {
          type: 'text',
          text: message
        })
        .catch(console.error);
      }
    });
  });
});

// 路由設定
app.use('/webhook', middleware(config));
app.post('/webhook', (req, res) => {
  Promise
    .all(req.body.events.map(handleEvent))
    .then((result) => res.json(result))
    .catch((err) => {
      console.error(err);
      res.status(500).end();
    });
});

// 健康檢查
app.get('/', (req, res) => {
  res.json({
    status: 'Enterprise Line Task Bot is running! 🏢',
    version: '2.0.0',
    features: [
      'Silent Meeting Recording',
      'AI Task Extraction', 
      'Enterprise Permission System',
      'Cross-Group Management',
      'Intelligent Notifications'
    ],
    timestamp: new Date().toISOString()
  });
});

// 錯誤處理
app.use((err, req, res, next) => {
  console.error(err.stack);
  res.status(500).json({ error: 'Something went wrong!' });
});

app.listen(port, () => {
  console.log(`🚀 Enterprise Line Task Bot Server is running on port ${port}`);
  console.log(`📱 Ready for enterprise task management!`);
  console.log(`🎯 Features: Silent Recording | AI Extraction | Permission Control`);
});
