import { useState, useEffect } from 'react';
import api from '../services/api';

const Rules = () => {
  const [rules, setRules] = useState([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const fetchRules = async () => {
      try {
        const res = await api.get('/rules');
        setRules(res.data);
      } catch (error) {
        console.error("Failed to fetch rules", error);
      } finally {
        setLoading(false);
      }
    };
    fetchRules();
  }, []);

  return (
    <div className="bg-white rounded-lg shadow-sm border border-gray-100 p-6">
      <div className="flex justify-between items-center mb-6">
        <h2 className="text-xl font-semibold text-gray-800">Automation Rules</h2>
        <button className="bg-blue-600 text-white px-4 py-2 rounded-lg text-sm font-medium hover:bg-blue-700">
          Create Rule
        </button>
      </div>

      {loading ? (
        <div>Loading...</div>
      ) : (
        <div className="grid gap-6">
          {rules.map((rule) => (
            <div key={rule._id} className="border border-gray-200 rounded-lg p-4 flex items-center justify-between">
              <div>
                <h3 className="font-semibold text-gray-800 text-lg">{rule.name}</h3>
                <p className="text-sm text-gray-500 mt-1">
                  IF <span className="font-mono text-blue-600 font-bold bg-blue-50 px-1 rounded">{rule.conditionType}</span> 
                  {' '}<span className="font-mono font-bold">{rule.operator}</span>{' '}
                  <span className="font-mono font-bold">{rule.value}</span> THEN 
                  {' '}<span className="font-mono text-red-600 font-bold bg-red-50 px-1 rounded uppercase">{rule.action}</span>
                </p>
                {rule.lastTriggered && (
                  <p className="text-xs text-gray-400 mt-2">
                    Last triggered: {new Date(rule.lastTriggered).toLocaleString()}
                  </p>
                )}
              </div>
              <div>
                <span className={`px-3 py-1 inline-flex text-sm leading-5 font-semibold rounded-full ${rule.status === 'active' ? 'bg-green-100 text-green-800' : 'bg-gray-100 text-gray-800'}`}>
                  {rule.status}
                </span>
              </div>
            </div>
          ))}
          {rules.length === 0 && (
            <p className="text-gray-500 italic">No rules defined. You can ask the AI assistant to create one!</p>
          )}
        </div>
      )}
    </div>
  );
};

export default Rules;
