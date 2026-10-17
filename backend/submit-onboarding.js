// Netlify Function to handle onboarding form submission and Talenox API integration

// Initialize Resend for email notifications
const { Resend } = require('resend');

const sendEmailOrThrow = async (resend, payload) => {
  const result = await resend.emails.send(payload);
  if (result && result.error) {
    throw new Error(result.error.message || 'Email service rejected the request');
  }
  return result ? result.data : null;
};

// Validate NRIC/FIN format (Singapore specific)
const validateNRIC = (nric) => {
  // Basic format check - starts with S, T, F, G, or M followed by 7 digits and 1 letter
  const nricRegex = /^[STFGM]\d{7}[A-Z]$/i;
  return nricRegex.test(nric);
};

// Validate required fields based on employee type
const validateFormData = (data) => {
  const errors = [];
  
  // Required for all
  if (!data.employeeType) errors.push('Employee type is required');
  if (!data.fullName) errors.push('Full name is required');
  if (!data.email) errors.push('Email is required');
  if (!data.nric) errors.push('NRIC/FIN is required');
  if (!data.nationality) errors.push('Nationality is required');
  if (!data.citizenshipStatus) errors.push('Citizenship status is required');
  if (!data.dob) errors.push('Date of birth is required');
  if (!data.gender) errors.push('Gender is required');
  if (!data.bank) errors.push('Bank is required');
  if (!data.accountName) errors.push('Account name is required');
  if (!data.accountNumber) errors.push('Account number is required');
  
  // Validate NRIC format with specific error messages
  if (data.nric) {
    const nricValue = data.nric.trim();
    if (nricValue.length !== 9) {
      if (nricValue.length === 4 && /^\d{4}$/.test(nricValue)) {
        errors.push('Please enter your complete 9-character NRIC/FIN, not just the last 4 digits');
      } else {
        errors.push('NRIC/FIN must be exactly 9 characters (e.g., S1234567A)');
      }
    } else if (!validateNRIC(nricValue)) {
      errors.push('Invalid NRIC/FIN format. It should start with S, T, F, G, or M followed by 7 digits and 1 letter');
    }
  }
  
  // Validate email format
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  if (data.email && !emailRegex.test(data.email)) {
    errors.push('Invalid email format');
  }
  
  // Validate dates based on employee type
  if (data.employeeType === 'intern_school') {
    if (!data.startDate) errors.push('Start date is required for interns');
    if (!data.endDate) errors.push('End date is required for interns');
    
    // Check that end date is after start date
    if (data.startDate && data.endDate) {
      const start = new Date(data.startDate);
      const end = new Date(data.endDate);
      if (end <= start) {
        errors.push('End date must be after start date');
      }
    }
  } else if (data.employeeType === 'fulltime') {
    if (!data.startDate) errors.push('Start date is required for full-time employees');
  }
  
  // Validate account number (digits only)
  if (data.accountNumber && !/^\d+$/.test(data.accountNumber)) {
    errors.push('Account number must contain only digits');
  }
  
  return errors;
};

// Create job for employee based on employee type
const createJobForEmployee = async (employeeId, formData, hiredDate, resignDate, requestId = 'unknown') => {
  try {
    // Calculate job start and end dates based on employee type
    let jobStartDate, jobEndDate, jobTitle, amount, department;
    
    const nextMonth = new Date();
    nextMonth.setMonth(nextMonth.getMonth() + 1);
    nextMonth.setDate(1); // First day of next month
    
    if (formData.employeeType === 'trainer') {
      jobTitle = 'Freelance Trainer';
      department = 'Tinkercademy';
      jobStartDate = hiredDate; // Same as hired date
      jobEndDate = resignDate; // Same as resign date
      amount = 0;
    } else if (formData.employeeType === 'intern_school') {
      jobTitle = 'Tinkertanker Intern';
      department = 'Internship';
      jobStartDate = nextMonth.toISOString().split('T')[0]; // Beginning of next month
      
      // End date 3 months later
      const threeMonthsLater = new Date(nextMonth);
      threeMonthsLater.setMonth(threeMonthsLater.getMonth() + 3);
      jobEndDate = threeMonthsLater.toISOString().split('T')[0];
      amount = 800;
    } else if (formData.employeeType === 'fulltime') {
      jobTitle = 'Tinkertanker Full-timer';
      department = 'Operations';
      jobStartDate = nextMonth.toISOString().split('T')[0]; // Beginning of next month
      // Set end date far in future for full-timers (required field)
      const farFuture = new Date(nextMonth);
      farFuture.setFullYear(farFuture.getFullYear() + 10);
      jobEndDate = farFuture.toISOString().split('T')[0];
      amount = 3000;
    }
    
    // Convert dates to DD/MM/YYYY format as shown in API docs
    const formatDate = (dateStr) => {
      const date = new Date(dateStr);
      const day = String(date.getDate()).padStart(2, '0');
      const month = String(date.getMonth() + 1).padStart(2, '0');
      const year = date.getFullYear();
      return `${day}/${month}/${year}`;
    };
    
    const jobData = {
      employee_id: parseInt(employeeId),
      title: jobTitle,
      job: {
        title: jobTitle,
        department: department,
        start_date: formatDate(jobStartDate),
        end_date: formatDate(jobEndDate),
        currency: 'SGD',
        amount: amount,
        rate_of_pay: 'Monthly',
        remarks: `Auto-created job for ${formData.employeeType}`
      }
    };
    
    console.log(`[${requestId}] Creating job for employee:`, employeeId);
    
    const jobResponse = await fetch(`${process.env.TALENOX_API_URL}/jobs`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${process.env.TALENOX_API_KEY}`,
        'Content-Type': 'application/json',
        'Accept': 'application/json'
      },
      body: JSON.stringify(jobData)
    });
    
    if (jobResponse.ok) {
      const jobResult = await jobResponse.json();
      console.log(`[${requestId}] Job created successfully:`, jobResult.id);
      return jobResult;
    } else {
      console.error('Job creation failed with status:', jobResponse.status);
      throw new Error(`Job creation failed: ${jobResponse.status}`);
    }
    
  } catch (error) {
    console.error(`[${requestId}] Error creating job`);
    throw error;
  }
};

// Maximum employee ID to consider valid (filters out database IDs)
const MAX_VALID_EMPLOYEE_ID = 10000;

// Get next employee ID by querying existing employees
const getNextEmployeeId = async (formData) => {
  try {
    // This list also prevents duplicate creation without relying on Talenox's error wording.
    const response = await fetch(`${process.env.TALENOX_API_URL}/employees?per=1000&sort=-created_at`, {
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${process.env.TALENOX_API_KEY}`,
        'Accept': 'application/json'
      }
    });
    
    if (response.ok) {
      const employees = await response.json();
      console.log('Found', employees.length || 0, 'existing employees');

      const normalizeName = (value) => String(value || '')
        .trim()
        .replace(/\s+/g, ' ')
        .toLowerCase();
      const normalizedEmail = String(formData.email || '').trim().toLowerCase();
      const normalizedName = normalizeName(formData.fullName);
      const existingEmployee = employees.find((employee) => {
        const employeeName = employee.identification_full_name || [
          employee.first_name,
          employee.middle_name,
          employee.last_name
        ].filter(Boolean).join(' ');

        return String(employee.email || '').trim().toLowerCase() === normalizedEmail &&
          normalizeName(employeeName) === normalizedName;
      });

      if (existingEmployee) {
        const duplicateError = new Error('An employee with these details is already registered in Talenox');
        duplicateError.errorType = 'duplicate';
        duplicateError.hrErrorType = 'Talenox API Error (duplicate)';
        duplicateError.hrErrorDetails = 'An employee with this name and email is already registered in Talenox';
        throw duplicateError;
      }
      
      // Look for Employee ID field (not database ID) - try multiple field names
      let maxEmployeeId = 0;
      
      if (employees && employees.length > 0) {
        employees.forEach((emp, index) => {
          // Try multiple possible field names for employee ID
          const possibleFields = [
            'employee_id', 'emp_id', 'employee_no', 'employee_number', 
            'staff_id', 'emp_no', 'employeeId', 'empId'
          ];
          
          let foundId = null;
          for (const field of possibleFields) {
            if (emp[field] && emp[field] !== emp.id) { // Make sure it's not the database ID
              foundId = emp[field];
              break;
            }
          }
          
          if (foundId) {
            const numericId = parseInt(foundId.toString().replace(/\D/g, ''), 10);
            if (!isNaN(numericId) && numericId > maxEmployeeId && numericId < MAX_VALID_EMPLOYEE_ID) { // Filter out large database IDs
              maxEmployeeId = numericId;
            }
          }
        });
      }
      
      console.log('Highest employee ID found:', maxEmployeeId);
      
      if (maxEmployeeId > 0) {
        const nextId = maxEmployeeId + 1;
        console.log('Next employee ID should be:', nextId);
        return nextId.toString();
      } else {
        // If no employee IDs found, start from 301 (since you mentioned 300+)
        console.log('No existing employee IDs found, starting from 301');
        return '301';
      }
    }

    throw new Error(`Talenox employee lookup failed (Status: ${response.status})`);
  } catch (error) {
    if (error.errorType === 'duplicate') throw error;
    console.error('Could not fetch existing employees');
    const lookupError = new Error('Could not retrieve existing employees from Talenox');
    lookupError.hrErrorType = 'Talenox API Error (employee lookup)';
    lookupError.hrErrorDetails = 'Could not check existing employees before creating the new profile';
    throw lookupError;
  }
};

const EMPLOYEE_TYPE_LABELS = {
  'trainer': 'Freelance/Contractor',
  'intern_school': 'Intern with School Letter',
  'fulltime': 'Full-time Employee'
};

// Send HR notification email
const sendHRNotification = async (formData, talenoxEmployeeId, jobId, internalEmployeeId) => {
  // Check if Resend is configured
  if (!process.env.RESEND_API_KEY || !process.env.NOTIFY_EMAIL) {
    console.log('Resend not configured, skipping notification');
    return;
  }

  try {
    const resend = new Resend(process.env.RESEND_API_KEY);
    
    const employeeTypeText = EMPLOYEE_TYPE_LABELS;

    const emailContent = `
New Employee Onboarding Submission

Employee Details:
- Name: ${formData.fullName}
- Employee Type: ${employeeTypeText[formData.employeeType] || formData.employeeType}
- Email: ${formData.email}
- Nationality: ${formData.nationality || 'Not specified'}
- Citizenship Status: ${formData.citizenshipStatus || 'Not specified'}

Talenox Integration:
- Internal Employee ID: ${internalEmployeeId}
- Talenox Database ID: ${talenoxEmployeeId}
- Job ID: ${jobId}
- Status: Successfully created with automatic user account invitation

Next Steps:
- Employee will receive Talenox account invitation email
- Review employee details in Talenox dashboard
- Confirm all information is correct

This is an automated notification from the Tinkercademy onboarding system.
    `.trim();

    await sendEmailOrThrow(resend, {
      from: process.env.FROM_EMAIL || 'Tinkercademy Onboarding <hr.onboarding@tinkertanker.com>',
      to: [process.env.NOTIFY_EMAIL || 'hr.onboarding@tinkertanker.com'],
      subject: `New Employee: ${formData.fullName} (${employeeTypeText[formData.employeeType] || formData.employeeType})`,
      text: emailContent
    });

    console.log('Notification sent successfully');
  } catch (error) {
    console.error('Failed to send notification');
    // Don't throw error - email failure shouldn't break the main flow
  }
};

// User-facing explanation (PDPA-safe: no NRIC/bank details)
const getFailureExplanation = (errorType) => {
  if (errorType === 'duplicate') {
    return {
      summary: 'Talenox reported that your details match an existing employee profile. No new account was created.',
      nextSteps: 'HR has been notified and will check the existing profile. Please do not submit the form again. Reply to this email only if your details need to be updated.'
    };
  }

  return {
    summary: 'We received the form, but could not finish setting up the account.',
    nextSteps: 'Please reply to this email so HR can follow up.'
  };
};

// One failure email to HR and the submitter together
const sendFailureNotification = async (
  formData,
  { employeeErrorType, hrErrorType, hrErrorDetails }
) => {
  if (!process.env.NOTIFY_EMAIL || !process.env.RESEND_API_KEY) {
    console.log('Resend not configured, skipping failure notification');
    return;
  }

  try {
    const resend = new Resend(process.env.RESEND_API_KEY);
    const employeeTypeText = EMPLOYEE_TYPE_LABELS;
    const explanation = getFailureExplanation(employeeErrorType);
    const hrEmail = process.env.NOTIFY_EMAIL;
    const recipients = [hrEmail];
    if (formData.email && formData.email.toLowerCase() !== hrEmail.toLowerCase()) {
      recipients.push(formData.email);
    }

    // Shared body is PDPA-safe: no raw API payloads, NRIC, or bank details
    const emailContent = `
Onboarding submission could not be completed

What happened:
${explanation.summary}

What to do next:
${explanation.nextSteps}

---
Submission details
- Name: ${formData.fullName || 'Not provided'}
- Employee Type: ${employeeTypeText[formData.employeeType] || formData.employeeType || 'Unknown'}
- Email: ${formData.email || 'Not provided'}
- Error Type: ${hrErrorType}
- Error Message: ${hrErrorDetails}
- Timestamp: ${new Date().toISOString()}

This is an automated message from the Tinkercademy onboarding system.
    `.trim();

    const payload = {
      from: process.env.FROM_EMAIL || 'Tinkercademy Onboarding <hr.onboarding@tinkertanker.com>',
      replyTo: hrEmail,
      subject: employeeErrorType === 'duplicate'
        ? `Already registered in Talenox: ${formData.fullName || 'Unknown'}`
        : `Onboarding could not be completed: ${formData.fullName || 'Unknown'} (${employeeTypeText[formData.employeeType] || 'Unknown'})`,
      text: emailContent
    };

    try {
      await sendEmailOrThrow(resend, { ...payload, to: recipients });
      console.log('Failure notification sent successfully');
    } catch (sharedSendError) {
      // Do not let a bad submitter address block the HR alert
      console.error('Shared failure email failed, retrying HR-only');
      if (recipients.length > 1) {
        await sendEmailOrThrow(resend, { ...payload, to: [hrEmail] });
        console.log('Failure notification sent to HR only');
      } else {
        throw sharedSendError;
      }
    }
  } catch (error) {
    console.error('Failed to send failure notification');
  }
};

const classifyEmployeeCreationError = (_status, errorText) => {
  const duplicatePatterns = [
    /\bduplicate\b/,
    /\balready\s+(?:exists?|registered|in use|(?:being\s+)?used|associated|linked)\b/,
    /\bhas\s+(?:already\s+)?been\s+taken\b/,
    /\bis\s+(?:already\s+)?(?:taken|in use|registered|associated|linked)\b/,
    /\b(?:must be|is not)\s+unique\b/,
    /\buniqueness\b/
  ];

  const hasDuplicateWording = (value) => {
    const message = String(value || '').toLowerCase();
    return duplicatePatterns.some((pattern) => pattern.test(message));
  };
  const identityField = /^(?:e_?mail|ssn|nric|identification(?:_?(?:number|full_?name))?)$/i;
  const identityWording = /\b(?:e-?mail|ssn|nric|identification(?: number)?|employee profile)\b/i;

  const containsIdentityDuplicate = (value, fieldName = '') => {
    if (Array.isArray(value)) {
      return value.some((item) => containsIdentityDuplicate(item, fieldName));
    }
    if (value && typeof value === 'object') {
      return Object.entries(value).some(([key, item]) =>
        containsIdentityDuplicate(item, key)
      );
    }

    return hasDuplicateWording(value) &&
      (identityField.test(fieldName) || identityWording.test(String(value || '')));
  };

  try {
    return containsIdentityDuplicate(JSON.parse(errorText)) ? 'duplicate' : 'unknown';
  } catch (error) {
    return containsIdentityDuplicate(errorText) ? 'duplicate' : 'unknown';
  }
};

// Transform data for Talenox API
const transformForTalenox = async (formData) => {
  // Nationality is defaulted to Singaporean for all employees
  
  // Map citizenship status based on employee type and citizenshipStatus
  const getCitizenshipStatus = (employeeType, citizenshipStatus) => {
    if (employeeType === 'trainer') {
      return 'Contract (No CPF, No SDL)';
    } else if (employeeType === 'intern_school') {
      return 'Contract (No CPF, No SDL)';
    } else if (employeeType === 'fulltime') {
      if (citizenshipStatus === 'sg_citizen') {
        return 'Singapore Citizen';
      } else if (citizenshipStatus === 'sg_pr') {
        return 'Singapore PR';
      } else {
        return 'Singapore Citizen'; // Default for full-timers
      }
    }
    return 'Contract (No CPF, No SDL)'; // Default fallback
  };
  
  // For trainers, calculate 1st of last month if no start date provided
  let hiredDate = formData.startDate;
  let resignDate = formData.endDate;
  
  if (formData.employeeType === 'trainer') {
    if (!hiredDate) {
      const lastMonth = new Date();
      lastMonth.setMonth(lastMonth.getMonth() - 1);
      lastMonth.setDate(1);
      hiredDate = lastMonth.toISOString().split('T')[0];
    }
    
    // Always set resign date as day after hired date for trainers
    const endDate = new Date(hiredDate);
    endDate.setDate(endDate.getDate() + 1);
    resignDate = endDate.toISOString().split('T')[0];
  }
  
  // Transform form data to Talenox API format
  return {
    // Core working fields
    first_name: formData.fullName,
    identification_full_name: formData.fullName,  // New field: full name as shown in identification
    email: formData.email,
    gender: formData.gender.charAt(0).toUpperCase() + formData.gender.slice(1),
    nationality: formData.nationality || 'Singaporean',
    hired_date: hiredDate,
    resign_date: resignDate || null,
    birthdate: formData.dob,
    ssn: formData.nric,
    employee_id: await getNextEmployeeId(formData),
    
    // Citizenship status based on employee type and citizenshipStatus
    citizenship: getCitizenshipStatus(formData.employeeType, formData.citizenshipStatus),
    
    // Banking information (nested structure)
    bank_account_attributes: {
      bank_type: formData.bank,
      account_name: formData.accountName,
      number: formData.accountNumber
    },
    
    // Job information
    job_title: formData.jobTitle,
    position: formData.jobTitle,
    
    // User account creation - automatically create and invite
    invite_user: true,
    
    // Additional metadata
    employee_type: formData.employeeType,
    requires_shg: formData.requiresSHG || false,
    country_id: 'SG'
  };
};

// Main handler function for background processing.
// `dispatch(formData, requestId)` hands accepted submissions to durable background
// processing (the Cloudflare queue). Without it, processing runs in this process.
exports.handler = async (event, { dispatch } = {}) => {
  // Handle CORS preflight
  if (event.httpMethod === 'OPTIONS') {
    return {
      statusCode: 200,
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Headers': 'Content-Type',
        'Access-Control-Allow-Methods': 'POST, OPTIONS'
      },
      body: ''
    };
  }
  
  // Only allow POST requests (after OPTIONS check)
  if (event.httpMethod !== 'POST') {
    return {
      statusCode: 405,
      headers: {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*'
      },
      body: JSON.stringify({ error: 'Method not allowed' })
    };
  }
  
  // Parse and validate quickly, then return 202 immediately
  try {
    const formData = JSON.parse(event.body);
    
    // Generate unique request ID for tracking
    const requestId = `req_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
    console.log(`[${requestId}] New submission request received`);
    
    // Quick validation before accepting
    const validationErrors = validateFormData(formData);
    if (validationErrors.length > 0) {
      console.log(`[${requestId}] Validation failed:`, validationErrors);
      return {
        statusCode: 400,
        headers: {
          'Content-Type': 'application/json',
          'Access-Control-Allow-Origin': '*'
        },
        body: JSON.stringify({ 
          error: 'Validation failed', 
          details: validationErrors,
          requestId: requestId 
        })
      };
    }
    
    // Return 202 Accepted immediately for background processing
    console.log(`[${requestId}] Accepted submission for background processing`);
    
    // Failure emails (HR + employee) are sent inside processOnboarding — once only
    if (dispatch) {
      try {
        await dispatch(formData, requestId);
      } catch {
        console.error(`[${requestId}] Could not queue submission`);
        return {
          statusCode: 503,
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            error: 'Submission not received',
            details: 'We could not accept your submission right now. Please try again in a few minutes, or contact HR at hr.onboarding@tk.sg.',
            requestId
          })
        };
      }
    } else {
      // processOnboarding logs failures and sends the failure notification.
      processOnboarding(formData, requestId).catch(() => {});
    }
    
    // Return immediately - client gets this response right away
    return {
      statusCode: 202,
      headers: {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*'
      },
      body: JSON.stringify({
        success: true,
        message: 'Your submission has been accepted and is being processed. If we cannot create your payroll account, we will email you and HR with next steps.',
        requestId: requestId
      })
    };
    
  } catch {
    console.error('Request parsing error');
    return {
      statusCode: 400,
      headers: {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*'
      },
      body: JSON.stringify({
        error: 'Invalid request',
        details: 'Could not parse request data'
      })
    };
  }
};

// Background processing function - runs after 202 response
async function processOnboarding(formData, requestId) {
  try {
    const startTime = Date.now();
    
    // Keep logs to operational metadata; partial redaction still exposes particulars.
    console.log(`[${requestId}] Processing submission in background`);
    
    // Transform data for Talenox (including employee ID generation)
    const transformStart = Date.now();
    const talenoxData = await transformForTalenox(formData);
    console.log(`[${requestId}] [Timing] Data transformation completed in ${Date.now() - transformStart}ms`);
    
    // Check if API key is configured
    if (!process.env.TALENOX_API_KEY || !process.env.TALENOX_API_URL) {
      console.error(`[${requestId}] Talenox API credentials not configured`);
      throw new Error('Talenox API is not properly configured');
    }
    
    // Call Talenox API
    console.log(`[${requestId}] Creating employee via Talenox API`);
    
    const talenoxResponse = await fetch(`${process.env.TALENOX_API_URL}/employees`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${process.env.TALENOX_API_KEY}`,
        'Content-Type': 'application/json',
        'Accept': 'application/json'
      },
      body: JSON.stringify(talenoxData)
    });
    
    if (!talenoxResponse.ok) {
      const errorText = await talenoxResponse.text();
      let errorMessage = 'Failed to create employee in Talenox';
      const errorType = classifyEmployeeCreationError(talenoxResponse.status, errorText);

      if (errorType === 'duplicate') {
        errorMessage = 'An employee with these details is already registered in Talenox';
      }
      
      const processingError = new Error(`${errorMessage} - ${errorType}`);
      processingError.errorType = errorType;
      processingError.hrErrorType = `Talenox API Error (${errorType})`;
      // Email-safe details only — raw Talenox body can echo NRIC/bank fields
      const safeEmailMessage = errorType === 'duplicate'
        ? 'An employee with these details is already registered in Talenox'
        : 'Failed to create employee in Talenox';
      processingError.hrErrorDetails = `${safeEmailMessage} (Status: ${talenoxResponse.status})`;
      console.error(`[${requestId}] Talenox employee creation failed:`, {
        status: talenoxResponse.status,
        errorType
      });
      throw processingError;
    }
    
    const talenoxResult = await talenoxResponse.json();
    const employeeId = talenoxResult.id || talenoxResult.employee_id;
    console.log(`[${requestId}] Employee created successfully with ID:`, employeeId);
    console.log(`[${requestId}] [Timing] Employee creation completed in ${Date.now() - startTime}ms`);
    
    // Create job for the employee and send notification email in parallel
    const jobStart = Date.now();
    const [jobResult] = await Promise.allSettled([
      createJobForEmployee(employeeId, formData, talenoxData.hired_date, talenoxData.resign_date, requestId),
      sendHRNotification(formData, employeeId, null, talenoxData.employee_id)
    ]);
    
    console.log(`[${requestId}] [Timing] Job creation completed in ${Date.now() - jobStart}ms`);
    console.log(`[${requestId}] [Timing] Total execution time: ${Date.now() - startTime}ms`);
    
    // Check job result
    const jobCreated = jobResult.status === 'fulfilled';
    const jobId = jobCreated ? jobResult.value?.id : null;
    
    if (!jobCreated) {
      console.error(`[${requestId}] Job creation failed, but employee was created`);
    } else {
      console.log(`[${requestId}] Job created successfully for employee:`, employeeId);
    }
    
    console.log(`[${requestId}] Background processing completed successfully`);
    return {
      success: true,
      employeeId: employeeId,
      jobId: jobId,
      jobCreated: jobCreated
    };
    
  } catch (error) {
    console.error(`[${requestId}] Background processing error`);
    
    // One email to HR and the submitter together (submitter already saw the success screen)
    const employeeErrorType = error.errorType === 'duplicate' ? 'duplicate' : 'system';
    await sendFailureNotification(formData, {
      employeeErrorType,
      hrErrorType: error.hrErrorType || 'System Error',
      // Keep shared email free of raw exception text that may echo request fields
      hrErrorDetails: error.hrErrorDetails || 'An unexpected error occurred during onboarding'
    });
    throw error;
  }
}

exports.processOnboarding = processOnboarding;
